import fs from 'fs-extra'
import os from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  avatarFileName,
  avatarIds,
  buildManifest,
  buildSheets,
  CELL_SIZE,
  MANIFEST_FILENAME,
  normalizeAvatar,
  publishAvatars,
  refreshAvatars,
  renderCircleBase64,
  resolveAvatarImage,
  supporterImageCandidates,
} from './avatars'
import { Supporter } from './opencollective'
import { ContributorSimple } from './types'

const makeImage = async (
  r: number,
  g: number,
  b: number,
): Promise<Buffer> =>
  normalizeAvatar(
    await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r, g, b, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  )

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const imageResponse = (buffer: Buffer): Response =>
  new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'image/webp' },
  })

let dir: string
let cacheDir: string
let distDir: string
let archivePath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'contributors-avatars-'))
  cacheDir = join(dir, 'cache')
  distDir = join(dir, 'dist')
  archivePath = join(dir, 'cache', 'opencollective', 'supporters.json')
})

afterEach(async () => {
  await fs.remove(dir)
})

describe('buildSheets', () => {
  it('lays out a single deterministic sheet of 96px cells, 16 per row', async () => {
    const [a, b] = [await makeImage(255, 0, 0), await makeImage(0, 255, 0)]
    const { sheets, avatars } = await buildSheets(
      ['github:a', 'github:b'],
      new Map([
        ['github:a', a],
        ['github:b', b],
      ]),
    )
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toMatchObject({ width: 16 * CELL_SIZE, height: CELL_SIZE })
    expect(avatars['github:a']).toEqual({
      sheet: 0,
      x: 0,
      y: 0,
      width: CELL_SIZE,
      height: CELL_SIZE,
    })
    expect(avatars['github:b']).toEqual({
      sheet: 0,
      x: CELL_SIZE,
      y: 0,
      width: CELL_SIZE,
      height: CELL_SIZE,
    })
  })

  it('rolls over at 256 cells into additional sheets', async () => {
    const image = await makeImage(10, 20, 30)
    const ids = Array.from({ length: 257 }, (_, index) =>
      `id:${String(index).padStart(3, '0')}`,
    )
    const { sheets, avatars } = await buildSheets(
      ids,
      new Map(ids.map(id => [id, image])),
    )
    expect(sheets).toHaveLength(2)
    expect(sheets[0]).toMatchObject({ width: 16 * CELL_SIZE, height: 16 * CELL_SIZE })
    expect(sheets[1]).toMatchObject({ width: 16 * CELL_SIZE, height: CELL_SIZE })
    expect(avatars[ids[256]].sheet).toBe(1)
    expect(avatars[ids[256]].x).toBe(0)
  })

  it('keeps the slot but omits manifest.avatars for a missing first-time image', async () => {
    const b = await makeImage(0, 0, 255)
    const { avatars } = await buildSheets(
      ['github:missing', 'github:present'],
      new Map([['github:present', b]]),
    )
    expect(avatars['github:missing']).toBeUndefined()
    expect(avatars['github:present']).toEqual({
      sheet: 0,
      x: CELL_SIZE,
      y: 0,
      width: CELL_SIZE,
      height: CELL_SIZE,
    })
  })
})

// Lossless WebP may discard RGB under fully transparent pixels; compare alpha
// everywhere and RGB only where alpha is nonzero (without a giant deepEqual).
const zeroTransparentRgb = (buffer: Buffer): Buffer => {
  const out = Buffer.alloc(buffer.length)
  for (let index = 0; index < buffer.length; index += 1) {
    out[index] = buffer[index]
  }
  for (let index = 3; index < out.length; index += 4) {
    if (out[index] === 0) {
      out[index - 3] = 0
      out[index - 2] = 0
      out[index - 1] = 0
    }
  }
  return out
}

const alphaEquals = (a: Buffer, b: Buffer): boolean => {
  for (let index = 3; index < a.length; index += 4) {
    if (a[index] !== b[index]) {
      return false
    }
  }
  return true
}

describe('normalizeAvatar', () => {
  it('preserves alpha and visible pixels through the lossless 96px encode', async () => {
    const raw = Buffer.alloc(CELL_SIZE * CELL_SIZE * 4)
    for (let y = 0; y < CELL_SIZE; y += 1) {
      for (let x = 0; x < CELL_SIZE; x += 1) {
        const index = (y * CELL_SIZE + x) * 4
        raw[index] = (x * 3 + y * 5) % 256
        raw[index + 1] = (x * 7 + y * 2) % 256
        raw[index + 2] = (x + y * 11) % 256
        raw[index + 3] = (x + y) % 5 === 0 ? 0 : 255
      }
    }
    const fixture = await sharp(raw, {
      raw: { width: CELL_SIZE, height: CELL_SIZE, channels: 4 },
    })
      .png()
      .toBuffer()

    const normalized = await normalizeAvatar(fixture)
    const metadata = await sharp(normalized).metadata()
    expect(metadata.width).toBe(CELL_SIZE)
    expect(metadata.height).toBe(CELL_SIZE)

    const decoded = await sharp(normalized).ensureAlpha().raw().toBuffer()
    const expected = await sharp(fixture).ensureAlpha().raw().toBuffer()
    expect(decoded.length).toBe(CELL_SIZE * CELL_SIZE * 4)
    expect(alphaEquals(decoded, expected)).toBe(true)
    const left = zeroTransparentRgb(decoded)
    const right = zeroTransparentRgb(expected) as unknown as Uint8Array
    expect(left.equals(right)).toBe(true)
  })
})

describe('determinism', () => {
  it('produces byte-identical sheets and manifest for identical input', async () => {
    const [a, b] = [await makeImage(1, 2, 3), await makeImage(4, 5, 6)]
    const ids = ['github:a', 'github:b']
    const images = new Map([
      ['github:a', a],
      ['github:b', b],
    ])
    const first = await buildSheets(ids, images)
    const second = await buildSheets(ids, images)
    expect(first.sheets).toEqual(second.sheets)
    expect(first.sheetFiles.map(file => file.buffer.toString('hex'))).toEqual(
      second.sheetFiles.map(file => file.buffer.toString('hex')),
    )

    const manifestA = buildManifest([], [], first.sheets, first.avatars)
    const manifestB = buildManifest([], [], second.sheets, second.avatars)
    expect(JSON.stringify(manifestA)).toBe(JSON.stringify(manifestB))
    expect(manifestA.version).toHaveLength(64)
  })
})

describe('avatarIds ordering', () => {
  const contributor = (id: string): { id: string; login: string; name: string; profile: string } => ({
    id,
    login: id,
    name: id,
    profile: 'https://example.com',
  })
  const supporter = (id: string): { id: string; memberId: number; name: string; profile: null } => ({
    id,
    memberId: 1,
    name: id,
    profile: null,
  })

  it('sorts combined ids independently of display order', () => {
    const forward = avatarIds(
      [contributor('github:b'), contributor('github:a')],
      [supporter('oc:z')],
    )
    const reversed = avatarIds(
      [contributor('github:a'), contributor('github:b')],
      [supporter('oc:z')],
    )
    expect(forward).toEqual(['github:a', 'github:b', 'oc:z'])
    expect(reversed).toEqual(forward)
  })
})

describe('resolveAvatarImage', () => {
  it('retains the last-good cached bytes when fetching fails', async () => {
    const cached = await makeImage(9, 8, 7)
    await fs.outputFile(join(cacheDir, avatarFileName('id:x')), cached)
    const failing = vi.fn(async () => {
      throw new Error('image down')
    })
    const result = await resolveAvatarImage(
      'id:x',
      ['https://example.com/x.png'],
      { cacheDir, distDir },
      failing as unknown as typeof fetch,
    )
    expect(result!.toString('hex')).toBe(cached.toString('hex'))
    expect(
      (await fs.readFile(join(cacheDir, avatarFileName('id:x')))).toString('hex'),
    ).toBe(cached.toString('hex'))
  })

  it('returns null for a first-time missing image without writing a placeholder', async () => {
    const failing = vi.fn(async () => {
      throw new Error('image down')
    })
    const result = await resolveAvatarImage(
      'id:new',
      ['https://example.com/new.png'],
      { cacheDir, distDir },
      failing as unknown as typeof fetch,
    )
    expect(result).toBeNull()
    expect(await fs.pathExists(join(cacheDir, avatarFileName('id:new')))).toBe(false)
  })

  it('propagates cache write failures instead of swallowing them', async () => {
    const blocked = join(dir, 'blocked')
    await fs.outputFile(blocked, 'not a directory')
    const workingFetch = vi.fn(async () => imageResponse(await makeImage(1, 2, 3)))
    await expect(
      resolveAvatarImage(
        'id:write',
        ['https://example.com/w.png'],
        { cacheDir: blocked, distDir },
        workingFetch as unknown as typeof fetch,
      ),
    ).rejects.toBeTruthy()
  })
})

describe('supporterImageCandidates', () => {
  const supporter = (overrides: Partial<Supporter>): Supporter => ({
    id: 'oc:https://opencollective.com/bob',
    memberId: 1,
    name: 'Bob',
    profile: 'https://opencollective.com/bob',
    image: 'https://example.com/bob.png',
    ...overrides,
  })

  it('returns no candidates when the OC image is null', () => {
    expect(supporterImageCandidates(supporter({ image: null }))).toEqual([])
  })

  it('tries the canonical CDN then the source, both http(s)', () => {
    expect(supporterImageCandidates(supporter({}))).toEqual([
      'https://images.opencollective.com/bob/avatar/128.png',
      'https://example.com/bob.png',
    ])
    expect(supporterImageCandidates(supporter({ image: 'javascript:alert(1)' }))).toEqual(
      [],
    )
  })

  it('only derives the CDN slug from an opencollective.com profile', () => {
    expect(
      supporterImageCandidates(
        supporter({ profile: 'https://example.com/bob' }),
      ),
    ).toEqual(['https://example.com/bob.png'])
  })
})

describe('publishAvatars', () => {
  it('writes sheets first and the manifest last', async () => {
    const order: string[] = []
    const write = vi.fn(async (filePath: string) => {
      order.push(filePath)
      return true
    })
    const manifest = buildManifest([], [], [
      { url: 'avatars-0.abc.webp', width: 1536, height: 96 },
    ], {})
    await publishAvatars(
      distDir,
      manifest,
      [{ url: 'avatars-0.abc.webp', width: 1536, height: 96, buffer: Buffer.from('x') }],
      write,
    )
    expect(order[0]).toBe(join(distDir, 'avatars-0.abc.webp'))
    expect(order[1]).toBe(join(distDir, MANIFEST_FILENAME))
  })

  it('does not publish the manifest when a sheet write fails', async () => {
    const writes: string[] = []
    const write = vi.fn(async (filePath: string) => {
      writes.push(filePath)
      if (filePath.endsWith('.webp')) {
        throw new Error('disk full')
      }
      return true
    })
    const manifest = buildManifest([], [], [
      { url: 'avatars-0.abc.webp', width: 1536, height: 96 },
    ], {})
    await expect(
      publishAvatars(
        distDir,
        manifest,
        [{ url: 'avatars-0.abc.webp', width: 1536, height: 96, buffer: Buffer.from('x') }],
        write,
      ),
    ).rejects.toThrow('disk full')
    expect(writes.some(filePath => filePath.endsWith(MANIFEST_FILENAME))).toBe(false)
  })
})

describe('refreshAvatars', () => {
  const contributors: ContributorSimple[] = [
    {
      login: 'Alice',
      name: '',
      avatar_url: 'https://img.example/alice.png',
      html_url: 'https://github.com/Alice',
    } as ContributorSimple,
  ]

  const members = [
    {
      MemberId: 1,
      name: 'Bob',
      profile: 'https://opencollective.com/bob/',
      image: 'https://example.com/bob.png',
      totalAmountDonated: 5,
      role: 'BACKER',
    },
    {
      MemberId: 2,
      name: '   ',
      profile: 'https://opencollective.com/ghost',
      image: null,
      totalAmountDonated: 3,
      role: 'ADMIN',
    },
  ]

  const routedFetch = (
    overrides: {
      images?: Record<string, Buffer>
      ocFails?: boolean
    } = {},
  ) => {
    const seenHeaders: Array<Record<string, unknown> | undefined> = []
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      seenHeaders.push(init?.headers as Record<string, unknown> | undefined)
      if (url.includes('rest.opencollective.com')) {
        if (overrides.ocFails) {
          throw new Error('OC down')
        }
        return jsonResponse(members)
      }
      const buffer = overrides.images?.[url]
      return buffer ? imageResponse(buffer) : new Response('nope', { status: 404 })
    })
    return { fetchImpl, seenHeaders, calls }
  }

  it('publishes sheets and a manifest with ordered people and omitted missing images', async () => {
    const { fetchImpl, seenHeaders } = routedFetch({
      images: {
        'https://img.example/alice.png': await makeImage(1, 1, 1),
        'https://images.opencollective.com/bob/avatar/128.png': await makeImage(2, 2, 2),
      },
    })
    const result = await refreshAvatars({
      contributors,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      distDir,
      archivePath,
    })

    expect(result.skipped).toBe(false)
    const manifest = await fs.readJson(join(distDir, MANIFEST_FILENAME))
    // contributor name blank -> login
    expect(manifest.contributors[0]).toMatchObject({
      id: 'github:alice',
      login: 'Alice',
      name: 'Alice',
      profile: 'https://github.com/Alice',
    })
    // supporter name blank -> empty
    expect(manifest.supporters.map((s: any) => s.id)).toEqual([
      'oc:https://opencollective.com/bob',
      'oc:https://opencollective.com/ghost',
    ])
    expect(manifest.supporters[1].name).toBe('')
    expect(manifest.avatars['github:alice']).toBeTruthy()
    expect(manifest.avatars['oc:https://opencollective.com/bob']).toBeTruthy()
    expect(manifest.avatars['oc:https://opencollective.com/ghost']).toBeUndefined()
    expect(await fs.pathExists(join(distDir, manifest.sheets[0].url))).toBe(true)
    expect(await fs.pathExists(archivePath)).toBe(true)
    // No GitHub credentials ever forwarded to OC or image hosts.
    seenHeaders.forEach(headers => expect(headers?.Authorization).toBeUndefined())
  })

  it('excludes bots at the refresh boundary (protects build:avatars)', async () => {
    const botContributor = {
      login: 'github-actions[bot]',
      name: '',
      avatar_url: 'https://img.example/bot.png',
      html_url: 'https://github.com/apps/github-actions',
    } as ContributorSimple
    const userBot = {
      login: 'chiba-bot',
      name: 'Chiba Bot',
      avatar_url: 'https://img.example/chiba.png',
      html_url: 'https://github.com/chiba-bot',
    } as ContributorSimple
    const { fetchImpl, calls } = routedFetch({
      images: { 'https://img.example/alice.png': await makeImage(3, 3, 3) },
    })
    await refreshAvatars({
      contributors: [...contributors, botContributor, userBot],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      distDir,
      archivePath,
    })
    const manifest = await fs.readJson(join(distDir, MANIFEST_FILENAME))
    expect(manifest.contributors.map((c: { login: string }) => c.login)).toEqual([
      'Alice',
    ])
    expect(manifest.avatars['github:github-actions[bot]']).toBeUndefined()
    expect(manifest.avatars['github:chiba-bot']).toBeUndefined()
    expect(calls).not.toContain('https://img.example/bot.png')
    expect(calls).not.toContain('https://img.example/chiba.png')
  })

  it('leaves the previous manifest byte-for-byte when OC fails', async () => {
    await fs.outputFile(join(distDir, MANIFEST_FILENAME), '{"previous":true}\n')
    const { fetchImpl } = routedFetch({ ocFails: true })
    const result = await refreshAvatars({
      contributors,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      distDir,
      archivePath,
    })
    expect(result.skipped).toBe(true)
    expect(await fs.readFile(join(distDir, MANIFEST_FILENAME), 'utf8')).toBe(
      '{"previous":true}\n',
    )
  })

  it('fails when OC fails and no previous manifest exists', async () => {
    const { fetchImpl } = routedFetch({ ocFails: true })
    await expect(
      refreshAvatars({
        contributors,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        cacheDir,
        distDir,
        archivePath,
      }),
    ).rejects.toThrow('OC down')
  })
})

describe('renderCircleBase64', () => {
  it('derives a non-empty PNG from a normalized avatar', async () => {
    const image = await makeImage(20, 40, 60)
    const base64 = await renderCircleBase64(image)
    expect(base64.length).toBeGreaterThan(0)
    const decoded = Buffer.from(base64, 'base64')
    expect(decoded.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })
})
