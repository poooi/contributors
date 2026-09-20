import fs from 'fs-extra'
import os from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildOptions, createBuildDeps, runBuild } from './build'
import { avatarIds, AvatarManifest, sha256Hex } from './avatars'
import { getContributors as fetchContributors, OctokitLike } from './github'
import { saveCachedData } from './cache'
import { Stat, Week } from './types'

const ALICE_URL = 'https://img.example/alice.png'
const ALICE_NEW_URL = 'https://img.example/alice-new.png'
const ALICE_BROKEN_URL = 'https://img.example/alice-broken.png'
const BOB_URL = 'https://img.example/bob.png'
const DONOR_URL = 'https://example.com/donor.png'

const week: Week = { w: 1, a: 1, d: 0, c: 1 }
const stat = (login: string, total: number): Stat => ({
  total,
  weeks: [week],
  author: { login } as unknown as Stat['author'],
})

const botStat = (login: string, total: number): Stat => ({
  total,
  weeks: [week],
  author: { login, type: 'Bot' } as unknown as Stat['author'],
})

const fakeOctokit = (data: Stat[]): OctokitLike => ({
  rest: {
    repos: {
      getContributorsStats: async () => ({ status: 200, data }),
      listForOrg: {},
    },
    users: { getByUsername: async () => ({ data: {} }) },
  },
  paginate: async () => [],
})

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const imageResponse = (buffer: Buffer): Response =>
  new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })

const solidPng = async (r: number, g: number, b: number): Promise<Buffer> =>
  sharp({ create: { width: 96, height: 96, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer()

// A colorful pattern with fully transparent and partially transparent pixels,
// so a lossy encode regression cannot slip past the visible-pixel comparison.
const patternPng = async (): Promise<Buffer> => {
  const size = 96
  const raw = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4
      raw[index] = (x * 7 + y * 3) % 256
      raw[index + 1] = (x * 2 + y * 11) % 256
      raw[index + 2] = (x * 5 + y * 5) % 256
      raw[index + 3] = (x + y) % 3 === 0 ? 0 : (x + y) % 2 === 0 ? 128 : 255
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}

const profile = (login: string, name: string, avatarUrl: string) => ({
  login,
  name,
  avatar_url: avatarUrl,
  html_url: `https://github.com/${login}`,
})

const members = [
  {
    MemberId: 1,
    name: 'Donor',
    profile: 'https://opencollective.com/donor',
    image: DONOR_URL,
    totalAmountDonated: 10,
    role: 'BACKER',
  },
  {
    MemberId: 2,
    name: '   ',
    profile: 'https://opencollective.com/anon',
    image: null,
    totalAmountDonated: 4,
    role: 'ADMIN',
  },
]

interface State {
  images: Record<string, Buffer>
  ocFails?: boolean
}

let dir: string
let state: State

const makeFetch = (current: State): { fetchImpl: typeof fetch; calls: string[] } => {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    calls.push(url)
    if (url.includes('rest.opencollective.com')) {
      if (current.ocFails) {
        throw new Error('OpenCollective down')
      }
      return jsonResponse(members)
    }
    const buffer = current.images[url]
    return buffer ? imageResponse(buffer) : new Response('nope', { status: 404 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

const buildOptions = (fetchImpl: typeof fetch): BuildOptions => ({
  distDir: join(dir, 'dist'),
  repoCacheDir: join(dir, 'cache'),
  avatarCacheDir: join(dir, 'cache', 'avatars'),
  avatarDistDir: join(dir, 'dist', 'avatars'),
  supportersArchivePath: join(dir, 'cache', 'opencollective', 'supporters.json'),
  fetchImpl,
})

const makeDeps = (fetchImpl: typeof fetch, aliceUrl: string = ALICE_URL) =>
  createBuildDeps(buildOptions(fetchImpl), {
    getRepos: async () => [{ full_name: 'poooi/poi' }],
    getContributors: async () => [stat('Alice', 3), stat('Bob', 2)],
    getUser: async login =>
      login.toLowerCase() === 'alice'
        ? profile('Alice', '', aliceUrl)
        : profile('Bob', 'Bob', BOB_URL),
    log: () => {},
    warn: () => {},
  })

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

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'contributors-build-int-'))
  state = {
    images: {
      [ALICE_URL]: await patternPng(),
      [DONOR_URL]: await solidPng(40, 120, 200),
    },
  }
  // Only the skipped-refresh path should reach global fetch; fail loudly rather
  // than touching the network if another path does.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('unexpected global fetch')
    }),
  )
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.remove(dir)
})

describe('runBuild integration (real avatar + sprite + svg pipeline)', () => {
  it('round-trips names, missing avatars, hashes, dimensions and lossless pixels', async () => {
    const { fetchImpl, calls } = makeFetch(state)
    await runBuild(makeDeps(fetchImpl))

    // The real SVG path reuses the archived image, so the contributor avatar is
    // fetched exactly once (during refresh) and never again for graph.svg.
    expect(calls.filter(url => url === ALICE_URL)).toHaveLength(1)

    const contributors = JSON.parse(
      await fs.readFile(join(dir, 'dist', 'contributors.json'), 'utf8'),
    ) as Array<{ login: string }>
    expect(contributors.map(entry => entry.login)).toEqual(
      expect.arrayContaining(['Alice', 'Bob']),
    )

    const svg = await fs.readFile(join(dir, 'dist', 'graph.svg'), 'utf8')
    expect(svg).toContain('id="Alice"')
    expect(svg).toContain('id="Bob"')

    const manifest = (await fs.readJson(
      join(dir, 'dist', 'avatars', 'manifest.json'),
    )) as AvatarManifest
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.version).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.cellSize).toBe(96)
    expect(manifest.displaySize).toBe(48)
    expect(manifest.pixelRatio).toBe(2)
    expect(manifest.sheets).toHaveLength(1)
    expect(manifest.sheets[0].url).toMatch(/^avatars-0\.[0-9a-f]{16}\.webp$/)
    expect(manifest.sheets[0]).toMatchObject({ width: 1536, height: 96 })

    const alice = manifest.contributors.find(entry => entry.id === 'github:alice')
    expect(alice).toMatchObject({ login: 'Alice', name: 'Alice' })
    const bob = manifest.contributors.find(entry => entry.id === 'github:bob')
    expect(bob).toMatchObject({ login: 'Bob', name: 'Bob' })
    const donor = manifest.supporters.find(
      entry => entry.id === 'oc:https://opencollective.com/donor',
    )
    expect(donor).toMatchObject({ name: 'Donor' })
    const anon = manifest.supporters.find(
      entry => entry.id === 'oc:https://opencollective.com/anon',
    )
    expect(anon).toMatchObject({ name: '' })

    expect(manifest.avatars['github:alice']).toBeTruthy()
    expect(manifest.avatars['oc:https://opencollective.com/donor']).toBeTruthy()
    expect(manifest.avatars['github:bob']).toBeUndefined()
    expect(manifest.avatars['oc:https://opencollective.com/anon']).toBeUndefined()

    const sheetPath = join(dir, 'dist', 'avatars', manifest.sheets[0].url)
    const sheet = await fs.readFile(sheetPath)
    expect(sha256Hex(sheet).slice(0, 16)).toBe(
      manifest.sheets[0].url.split('.')[1],
    )

    const slot = manifest.avatars['github:alice']
    const cell = await sharp(sheet)
      .extract({ left: slot.x, top: slot.y, width: 96, height: 96 })
      .ensureAlpha()
      .raw()
      .toBuffer()
    const cached = await fs.readFile(
      join(dir, 'cache', 'avatars', `${sha256Hex('github:alice')}.webp`),
    )
    const normalized = await sharp(cached).ensureAlpha().raw().toBuffer()
    expect(alphaEquals(cell, normalized)).toBe(true)
    const crispCell = zeroTransparentRgb(cell)
    const crispNormalized = zeroTransparentRgb(normalized) as unknown as Uint8Array
    expect(crispCell.equals(crispNormalized)).toBe(true)

    const ids = avatarIds(manifest.contributors, manifest.supporters)
    const missingIndex = ids.indexOf('github:bob')
    const missingCell = await sharp(sheet)
      .extract({
        left: (missingIndex % 16) * 96,
        top: Math.floor(missingIndex / 16) * 96,
        width: 96,
        height: 96,
      })
      .ensureAlpha()
      .raw()
      .toBuffer()
    expect(missingCell[3]).toBe(0)
  })

  it('is byte-stable across identical reruns', async () => {
    await runBuild(makeDeps(makeFetch(state).fetchImpl))
    const first = {
      contributors: await fs.readFile(join(dir, 'dist', 'contributors.json')),
      svg: await fs.readFile(join(dir, 'dist', 'graph.svg')),
      manifest: await fs.readFile(join(dir, 'dist', 'avatars', 'manifest.json')),
      sheet: await fs.readFile(
        join(
          dir,
          'dist',
          'avatars',
          (await fs.readJson(
            join(dir, 'dist', 'avatars', 'manifest.json'),
          )).sheets[0].url,
        ),
      ),
    }

    await runBuild(makeDeps(makeFetch(state).fetchImpl))
    expect(await fs.readFile(join(dir, 'dist', 'contributors.json'))).toEqual(
      first.contributors,
    )
    expect(await fs.readFile(join(dir, 'dist', 'graph.svg'))).toEqual(first.svg)
    expect(
      await fs.readFile(join(dir, 'dist', 'avatars', 'manifest.json')),
    ).toEqual(first.manifest)
    const secondManifest = await fs.readJson(
      join(dir, 'dist', 'avatars', 'manifest.json'),
    )
    expect(
      await fs.readFile(join(dir, 'dist', 'avatars', secondManifest.sheets[0].url)),
    ).toEqual(first.sheet)
  })

  it('retains previous sheets and last-good image by id across change/failure', async () => {
    const { fetchImpl } = makeFetch(state)
    const cachePath = join(dir, 'cache', 'avatars', `${sha256Hex('github:alice')}.webp`)

    await runBuild(makeDeps(fetchImpl, ALICE_URL))
    const firstUrl = (
      (await fs.readJson(join(dir, 'dist', 'avatars', 'manifest.json'))) as AvatarManifest
    ).sheets[0].url
    const firstCache = await fs.readFile(cachePath)

    // The avatar URL changes and the new image is fetched: a new hashed sheet
    // appears and the previous sheet is retained on disk.
    state.images[ALICE_NEW_URL] = await solidPng(10, 200, 120)
    await runBuild(makeDeps(fetchImpl, ALICE_NEW_URL))
    const second = (await fs.readJson(
      join(dir, 'dist', 'avatars', 'manifest.json'),
    )) as AvatarManifest
    const secondUrl = second.sheets[0].url
    expect(secondUrl).not.toBe(firstUrl)
    expect(await fs.pathExists(join(dir, 'dist', 'avatars', firstUrl))).toBe(true)
    const secondCache = await fs.readFile(cachePath)
    expect(secondCache.equals(firstCache as unknown as Uint8Array)).toBe(false)

    // The URL changes again to an unreachable one: the last-good image is
    // retained by id, so the manifest and sheet are unchanged and the old
    // hashed sheets survive.
    await runBuild(makeDeps(fetchImpl, ALICE_BROKEN_URL))
    const third = (await fs.readJson(
      join(dir, 'dist', 'avatars', 'manifest.json'),
    )) as AvatarManifest
    expect(third.sheets[0].url).toBe(secondUrl)
    expect(third.version).toBe(second.version)
    expect(third.avatars['github:alice']).toBeTruthy()
    expect(
      (await fs.readFile(cachePath)).equals(secondCache as unknown as Uint8Array),
    ).toBe(true)
    expect(await fs.pathExists(join(dir, 'dist', 'avatars', firstUrl))).toBe(true)
    expect(await fs.pathExists(join(dir, 'dist', 'avatars', secondUrl))).toBe(true)
  })

  it('preserves last-good manifest, sheet, cache and archive when OC fails', async () => {
    await runBuild(makeDeps(makeFetch(state).fetchImpl))
    const manifestPath = join(dir, 'dist', 'avatars', 'manifest.json')
    const manifest = (await fs.readJson(manifestPath)) as AvatarManifest
    const sheetPath = join(dir, 'dist', 'avatars', manifest.sheets[0].url)
    const cachePath = join(dir, 'cache', 'avatars', `${sha256Hex('github:alice')}.webp`)
    const archivePath = join(dir, 'cache', 'opencollective', 'supporters.json')

    const before = {
      manifest: await fs.readFile(manifestPath),
      sheet: await fs.readFile(sheetPath),
      cache: await fs.readFile(cachePath),
      archive: await fs.readFile(archivePath),
    }

    // OC fails and images are served by the injected fetch, so the skipped
    // graph fallback never touches the real network.
    const offline = await solidPng(1, 2, 3)
    const failingOcFetch = vi.fn(async (url: string) => {
      if (url.includes('rest.opencollective.com')) {
        throw new Error('OpenCollective down')
      }
      return imageResponse(offline)
    })
    state.ocFails = true
    await runBuild(makeDeps(failingOcFetch as unknown as typeof fetch))

    expect(await fs.readFile(manifestPath)).toEqual(before.manifest)
    expect(await fs.readFile(sheetPath)).toEqual(before.sheet)
    expect(await fs.readFile(cachePath)).toEqual(before.cache)
    expect(await fs.readFile(archivePath)).toEqual(before.archive)
  })

  it('publishes nothing on a first-run OC failure', async () => {
    state.ocFails = true
    await expect(runBuild(makeDeps(makeFetch(state).fetchImpl))).rejects.toBeTruthy()

    expect(await fs.pathExists(join(dir, 'dist'))).toBe(false)
    expect(await fs.pathExists(join(dir, 'dist', 'contributors.json'))).toBe(false)
    expect(await fs.pathExists(join(dir, 'dist', 'graph.svg'))).toBe(false)
    expect(await fs.pathExists(join(dir, 'dist', 'avatars', 'manifest.json'))).toBe(
      false,
    )
    expect(
      await fs.pathExists(join(dir, 'cache', 'opencollective', 'supporters.json')),
    ).toBe(false)
  })

  it('keeps cache and outputs byte-identical when only bot totals change', async () => {
    const cacheDir = join(dir, 'cache')
    const humanUrl = 'https://img.example/Javran.png'
    state.images[humanUrl] = await patternPng()
    const fetchImpl = makeFetch(state).fetchImpl

    const human = stat('Javran', 5)
    const depsFor = (raw: Stat[]) =>
      createBuildDeps(buildOptions(fetchImpl), {
        getRepos: async () => [{ full_name: 'poooi/poi' }],
        getContributors: (owner, repo, previous) =>
          fetchContributors(owner, repo, {
            octokit: fakeOctokit(raw),
            previous,
            retry: {
              retries: 0,
              minTimeout: 0,
              maxTimeout: 0,
              totalBudgetMs: 1000,
              requestTimeoutMs: 1000,
              sleep: async () => {},
              now: () => 0,
            },
            save: (name, data) => saveCachedData(name, data, cacheDir),
          }),
        getUser: async login =>
          profile(login, login, `https://img.example/${login}.png`),
        log: () => {},
        warn: () => {},
      })

    await runBuild(depsFor([human, botStat('github-actions[bot]', 14)]))
    const manifestPath = join(dir, 'dist', 'avatars', 'manifest.json')
    const archivePath = join(cacheDir, 'poooi_poi.json')
    const firstManifest = (await fs.readJson(manifestPath)) as AvatarManifest
    const first = {
      cache: await fs.readFile(archivePath),
      contributors: await fs.readFile(join(dir, 'dist', 'contributors.json')),
      svg: await fs.readFile(join(dir, 'dist', 'graph.svg')),
      manifest: await fs.readFile(manifestPath),
      sheet: await fs.readFile(join(dir, 'dist', 'avatars', firstManifest.sheets[0].url)),
    }
    expect(first.cache.toString('utf8')).not.toContain('github-actions')

    // Only the bot total changed; every human-facing artifact must be stable.
    await runBuild(depsFor([human, botStat('github-actions[bot]', 15)]))
    const secondManifest = (await fs.readJson(manifestPath)) as AvatarManifest
    expect(await fs.readFile(archivePath)).toEqual(first.cache)
    expect(await fs.readFile(join(dir, 'dist', 'contributors.json'))).toEqual(
      first.contributors,
    )
    expect(await fs.readFile(join(dir, 'dist', 'graph.svg'))).toEqual(first.svg)
    expect(await fs.readFile(manifestPath)).toEqual(first.manifest)
    expect(
      await fs.readFile(join(dir, 'dist', 'avatars', secondManifest.sheets[0].url)),
    ).toEqual(first.sheet)
  })
})
