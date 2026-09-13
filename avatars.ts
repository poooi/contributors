import bluebird from 'bluebird'
import fs from 'fs-extra'
import { createHash } from 'crypto'
import { join } from 'path'
import pRetry from 'p-retry'
import sharp from 'sharp'
import { writeIfChanged, Writer } from './atomic'
import {
  collectSupporters,
  isHttpUrl,
  saveSupportersArchive,
  Supporter,
} from './opencollective'
import { ContributorSimple } from './types'

export const CELL_SIZE = 96
export const DISPLAY_SIZE = 48
export const PIXEL_RATIO = 2
export const SHEET_COLUMNS = 16
export const MAX_CELLS_PER_SHEET = 256
export const SCHEMA_VERSION = 1

const WEBP_EFFORT = 6
// Both the 96px archives and the final sprite sheets use lossless WebP
// compression, so there is no additional visible-pixel loss at any step.
const WEBP_OPTIONS: sharp.WebpOptions = {
  lossless: true,
  effort: WEBP_EFFORT,
}
const CACHE_CONCURRENCY = 4
const IMAGE_TIMEOUT_MS = 15_000
const IMAGE_RETRIES = 1
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
// Bound decode work proportionally to the 96px target: sources larger than
// 64x the target edge are rejected before sharp decodes them.
const MAX_INPUT_PIXELS = (CELL_SIZE * 64) ** 2
const PLACEHOLDER_HASH_PREFIX = 16
const OC_IMAGE_HOSTS = new Set(['opencollective.com', 'www.opencollective.com'])

export const DEFAULT_CACHE_DIR = join(__dirname, 'cache', 'avatars')
export const DEFAULT_DIST_DIR = join(__dirname, 'dist', 'avatars')
export const MANIFEST_FILENAME = 'manifest.json'

export interface SpriteSheet {
  url: string
  width: number
  height: number
}

export interface AvatarSlot {
  sheet: number
  x: number
  y: number
  width: number
  height: number
}

export interface ManifestContributor {
  id: string
  login: string
  name: string
  profile: string
}

export interface ManifestSupporter {
  id: string
  memberId: number
  name: string
  profile: string | null
}

export interface AvatarManifest {
  schemaVersion: number
  version: string
  cellSize: number
  displaySize: number
  pixelRatio: number
  sheets: SpriteSheet[]
  avatars: Record<string, AvatarSlot>
  contributors: ManifestContributor[]
  supporters: ManifestSupporter[]
}

export interface AvatarDirs {
  cacheDir: string
  distDir: string
}

export interface AvatarRefreshResult {
  skipped: boolean
  contributors: ManifestContributor[]
  supporters: ManifestSupporter[]
  contributorImages: Map<string, Buffer>
}

export interface AvatarRefreshOptions {
  contributors: ContributorSimple[]
  fetchImpl?: typeof fetch
  cacheDir?: string
  distDir?: string
  archivePath?: string
  log?: (message: string) => void
  warn?: (message: string) => void
}

export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256')
    .update(data as unknown as Uint8Array)
    .digest('hex')

// Hashed, ID-derived filename so any public id maps to a stable cache path.
export const avatarFileName = (id: string): string => `${sha256Hex(id)}.webp`

export const normalizeAvatar = async (input: Buffer): Promise<Buffer> =>
  sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(CELL_SIZE, CELL_SIZE, { fit: 'cover', position: 'centre' })
    .webp(WEBP_OPTIONS)
    .toBuffer()

// Derive the 64px circular PNG embedded in graph.svg from an already-fetched
// normalized avatar, so contributors are never fetched twice per run.
export const renderCircleBase64 = async (
  source: Buffer,
  size = 64,
): Promise<string> => {
  const round = Buffer.from(
    `<svg><rect x="0" y="0" width="${size}" height="${size}" rx="${size / 2}" ry="${size /
      2}"/></svg>`,
  )
  const image = await sharp(source)
    .resize(size)
    .composite([{ input: round, blend: 'dest-in' }])
    .png()
    .toBuffer()
  return image.toString('base64')
}

export const profileSlug = (profile: string | null): string | null => {
  if (!profile) {
    return null
  }
  try {
    const url = new URL(profile)
    if (!OC_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {
      return null
    }
    const segments = url.pathname
      .replace(/\/+$/, '')
      .split('/')
      .filter(Boolean)
    return segments.length > 0 ? segments[segments.length - 1] : null
  } catch {
    return null
  }
}

// A null OC image means "absent": no synthetic CDN default. When a source image
// exists, try the canonical images.opencollective.com avatar (128px) first,
// then the source URL as fallback.
export const supporterImageCandidates = (supporter: Supporter): string[] => {
  if (!supporter.image || !isHttpUrl(supporter.image)) {
    return []
  }
  const candidates: string[] = []
  const slug = profileSlug(supporter.profile)
  if (slug) {
    candidates.push(`https://images.opencollective.com/${slug}/avatar/128.png`)
  }
  candidates.push(supporter.image)
  return candidates
}

const fetchImage = async (
  url: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> => {
  return pRetry(
    async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: 'image/*' },
          redirect: 'follow',
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`image request failed with status ${response.status}`)
        }
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
          throw new Error('image exceeds the maximum allowed size')
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > MAX_SOURCE_BYTES) {
          throw new Error('image exceeds the maximum allowed size')
        }
        return buffer
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`image request timed out after ${IMAGE_TIMEOUT_MS}ms`)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
    { retries: IMAGE_RETRIES, minTimeout: 0, maxTimeout: 0 },
  )
}

const readCachedAvatar = async (
  id: string,
  cacheDir: string,
): Promise<Buffer | null> => {
  try {
    const filePath = join(cacheDir, avatarFileName(id))
    if (await fs.pathExists(filePath)) {
      return await fs.readFile(filePath)
    }
  } catch (error) {
    console.warn(`Failed to read cached avatar for ${id}:`, error)
  }
  return null
}

// Refresh one avatar. A successful fetch is normalized, archived and returned;
// any fetch/decode failure falls back to the last-good cached bytes without
// touching them. Persistence sits outside the fetch catch so cache write
// failures propagate instead of silently falling through to a fetch retry.
export const resolveAvatarImage = async (
  id: string,
  candidates: string[],
  dirs: AvatarDirs,
  fetchImpl: typeof fetch,
): Promise<Buffer | null> => {
  const cached = await readCachedAvatar(id, dirs.cacheDir)
  for (const url of candidates) {
    let normalized: Buffer
    try {
      const raw = await fetchImage(url, fetchImpl)
      normalized = await normalizeAvatar(raw)
    } catch {
      // Try the next candidate; retain last-good below.
      continue
    }
    await writeIfChanged(join(dirs.cacheDir, avatarFileName(id)), normalized)
    return normalized
  }
  return cached
}

// Deterministic neutral image used only by graph.svg when a refresh succeeded
// but a first-time avatar is unavailable; never used for sprite manifest tiles.
export const renderPlaceholderBase64 = async (size = 64): Promise<string> => {
  const disc = Buffer.from(
    `<svg><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#E0E0E0"/></svg>`,
  )
  const image = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: disc, blend: 'over' }])
    .png()
    .toBuffer()
  return image.toString('base64')
}

export interface SheetFile extends SpriteSheet {
  buffer: Buffer
}

// Deterministic layout: slots come from the sorted combined ids (independent of
// display order). Ids without a byte image keep their slot but are omitted from
// manifest.avatars, leaving an empty cell rather than a placeholder tile.
export const buildSheets = async (
  ids: string[],
  images: Map<string, Buffer>,
): Promise<{
  sheets: SpriteSheet[]
  avatars: Record<string, AvatarSlot>
  sheetFiles: SheetFile[]
}> => {
  const avatars: Record<string, AvatarSlot> = {}
  const sheets: SpriteSheet[] = []
  const sheetFiles: SheetFile[] = []
  const sheetCount = Math.ceil(ids.length / MAX_CELLS_PER_SHEET)

  for (let sheet = 0; sheet < sheetCount; sheet += 1) {
    const start = sheet * MAX_CELLS_PER_SHEET
    const count = Math.min(MAX_CELLS_PER_SHEET, ids.length - start)
    const rows = Math.ceil(count / SHEET_COLUMNS)
    const width = SHEET_COLUMNS * CELL_SIZE
    const height = rows * CELL_SIZE
    const composites: sharp.OverlayOptions[] = []

    for (let index = 0; index < count; index += 1) {
      const id = ids[start + index]
      const image = images.get(id)
      if (!image) {
        continue
      }
      const x = (index % SHEET_COLUMNS) * CELL_SIZE
      const y = Math.floor(index / SHEET_COLUMNS) * CELL_SIZE
      avatars[id] = {
        sheet,
        x,
        y,
        width: CELL_SIZE,
        height: CELL_SIZE,
      }
      composites.push({ input: image, left: x, top: y })
    }

    let pipeline = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
    if (composites.length > 0) {
      pipeline = pipeline.composite(composites)
    }
    const buffer = await pipeline.webp(WEBP_OPTIONS).toBuffer()
    const url = `avatars-${sheet}.${sha256Hex(buffer).slice(
      0,
      PLACEHOLDER_HASH_PREFIX,
    )}.webp`
    const file: SheetFile = { url, width, height, buffer }
    sheets.push({ url, width, height })
    sheetFiles.push(file)
  }

  return { sheets, avatars, sheetFiles }
}

export const avatarIds = (
  contributors: ManifestContributor[],
  supporters: ManifestSupporter[],
): string[] =>
  [
    ...new Set([
      ...contributors.map(contributor => contributor.id),
      ...supporters.map(supporter => supporter.id),
    ]),
  ].sort()

// The version is a content digest over the canonical manifest body, so it
// changes only when published content changes and never includes timestamps.
export const buildManifest = (
  contributors: ManifestContributor[],
  supporters: ManifestSupporter[],
  sheets: SpriteSheet[],
  avatars: Record<string, AvatarSlot>,
): AvatarManifest => {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    cellSize: CELL_SIZE,
    displaySize: DISPLAY_SIZE,
    pixelRatio: PIXEL_RATIO,
    sheets,
    avatars,
    contributors,
    supporters,
  }
  const version = sha256Hex(JSON.stringify(base))
  return { version, ...base }
}

// Publish sheets first, then the manifest atomically last. Any write error
// aborts before the manifest so consumers never see a manifest without sheets.
export const publishAvatars = async (
  distDir: string,
  manifest: AvatarManifest,
  sheetFiles: SheetFile[],
  write: Writer = writeIfChanged,
): Promise<void> => {
  await fs.ensureDir(distDir)
  for (const sheet of sheetFiles) {
    await write(join(distDir, sheet.url), sheet.buffer)
  }
  await write(
    join(distDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

const normalizeContributorName = (contributor: ContributorSimple): string => {
  const name = (contributor as { name?: unknown }).name
  if (typeof name === 'string' && name.trim() !== '') {
    return name
  }
  return contributor.login
}

// Collect public donors, refresh/archive every avatar, then publish the sprite
// sheets and manifest. When the OC source is unavailable and a previous
// manifest exists, nothing is touched; with no previous manifest the build
// fails rather than publish an empty donor list.
export const refreshAvatars = async (
  options: AvatarRefreshOptions,
): Promise<AvatarRefreshResult> => {
  const dirs: AvatarDirs = {
    cacheDir: options.cacheDir ?? DEFAULT_CACHE_DIR,
    distDir: options.distDir ?? DEFAULT_DIST_DIR,
  }
  const log = options.log ?? (message => console.info(message))
  const warn = options.warn ?? (message => console.warn(message))
  const fetchImpl = options.fetchImpl ?? fetch
  const manifestPath = join(dirs.distDir, MANIFEST_FILENAME)

  let collection: { supporters: Supporter[]; fromArchive: boolean }
  try {
    collection = await collectSupporters({
      fetchImpl,
      archivePath: options.archivePath,
    })
    if (collection.fromArchive) {
      throw new Error(
        'OpenCollective source unavailable and no fresh donors to publish',
      )
    }
  } catch (error) {
    if (await fs.pathExists(manifestPath)) {
      warn('⚠️  keeping previous avatars manifest untouched')
      return {
        skipped: true,
        contributors: [],
        supporters: [],
        contributorImages: new Map(),
      }
    }
    throw error
  }

  await saveSupportersArchive(collection.supporters, options.archivePath)

  const contributors: ManifestContributor[] = options.contributors.map(
    contributor => ({
      id: `github:${contributor.login.toLowerCase()}`,
      login: contributor.login,
      name: normalizeContributorName(contributor),
      profile: isHttpUrl(contributor.html_url)
        ? contributor.html_url
        : `https://github.com/${contributor.login}`,
    }),
  )
  const supporters: ManifestSupporter[] = collection.supporters.map(
    supporter => ({
      id: supporter.id,
      memberId: supporter.memberId,
      name: supporter.name,
      profile: supporter.profile,
    }),
  )

  const contributorsWithImages: Map<string, Buffer> = new Map()
  const images: Map<string, Buffer> = new Map()
  await bluebird.map(
    options.contributors,
    async (contributor, index) => {
      const id = contributors[index].id
      const candidates = isHttpUrl(contributor.avatar_url)
        ? [contributor.avatar_url]
        : []
      const buffer = await resolveAvatarImage(id, candidates, dirs, fetchImpl)
      if (buffer) {
        images.set(id, buffer)
        contributorsWithImages.set(contributor.avatar_url, buffer)
      }
    },
    { concurrency: CACHE_CONCURRENCY },
  )
  await bluebird.map(
    collection.supporters,
    async supporter => {
      const buffer = await resolveAvatarImage(
        supporter.id,
        supporterImageCandidates(supporter),
        dirs,
        fetchImpl,
      )
      if (buffer) {
        images.set(supporter.id, buffer)
      }
    },
    { concurrency: CACHE_CONCURRENCY },
  )

  const ids = avatarIds(contributors, supporters)
  const { sheets, avatars, sheetFiles } = await buildSheets(ids, images)
  const manifest = buildManifest(contributors, supporters, sheets, avatars)
  await publishAvatars(dirs.distDir, manifest, sheetFiles)

  log(
    `🖼️  avatars: ${Object.keys(avatars).length}/${ids.length} images across ${
      sheets.length
    } sheet(s)`,
  )
  return {
    skipped: false,
    contributors,
    supporters,
    contributorImages: contributorsWithImages,
  }
}
