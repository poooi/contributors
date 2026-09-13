import { describe, expect, it, vi } from 'vitest'
import { MORE_REPO, OVERWRITES } from './config'
import {
  aggregateContributors,
  BuildDeps,
  resolveRepoList,
  runBuild,
  splitRepo,
  toKnownUsers,
} from './build'
import { ContributorSimple, Stat, Week } from './types'

const week = (overrides: Partial<Week> = {}): Week => ({
  w: 1,
  a: 1,
  d: 0,
  c: 1,
  ...overrides,
})

const stat = (login: string | null, total = 1): Stat => ({
  total,
  weeks: [week()],
  author: login ? ({ login } as unknown as Stat['author']) : null,
})

describe('splitRepo', () => {
  it('keeps underscores in the repo part', () => {
    expect(splitRepo('ruiii/poi_theme_paper_dark')).toEqual([
      'ruiii',
      'poi_theme_paper_dark',
    ])
    expect(splitRepo('invalid')).toBeNull()
  })
})

describe('resolveRepoList', () => {
  it('falls back to archives/manifest and preserves underscores on discovery failure', () => {
    const repos = resolveRepoList({
      discovered: [],
      archived: ['ruiii/poi_theme_paper_dark'],
      manifest: ['poooi/old-repo'],
      extra: ['kcwikizh/poi-statistics'],
      ignored: ['poooi/settings-panel'],
    })
    expect(repos).toContain('ruiii/poi_theme_paper_dark')
    expect(repos).toContain('poooi/old-repo')
    expect(repos).toContain('kcwikizh/poi-statistics')
    expect(repos).toEqual([...repos].sort())
  })

  it('never equates a missing discovery entry with deletion but still filters ignores', () => {
    const repos = resolveRepoList({
      discovered: [{ full_name: 'poooi/poi' }],
      archived: ['poooi/poi', 'poooi/settings-panel'],
      manifest: [],
      extra: [],
      ignored: ['poooi/settings-panel'],
    })
    expect(repos).toEqual(['poooi/poi'])
  })
})

describe('toKnownUsers', () => {
  it('captures enough metadata to survive a failed profile lookup', () => {
    const users = toKnownUsers([
      { login: 'Javran', avatar_url: 'avatar', html_url: 'url' } as ContributorSimple,
    ])
    expect(users.get('Javran')).toMatchObject({ avatar_url: 'avatar', html_url: 'url' })
  })
})

describe('aggregateContributors', () => {
  it('keeps known contributors when the profile lookup fails', async () => {
    const knownUsers = new Map([
      ['Javran', { login: 'Javran', avatar_url: 'old-avatar', html_url: 'old-url' }],
    ])
    const collection = await aggregateContributors(
      [{ repoName: 'Javran/poi-plugin-mo2', stats: [stat('Javran', 4)] }],
      {
        getUser: async () => {
          throw new Error('profile down')
        },
        knownUsers,
        aliases: {},
      },
    )
    expect(collection.Javran).toMatchObject({
      avatar_url: 'old-avatar',
      html_url: 'old-url',
      total: 4,
      perRepo: { 'Javran/poi-plugin-mo2': 4 },
    })
  })

  it('applies aliases and merges totals across repos', async () => {
    const collection = await aggregateContributors(
      [
        { repoName: 'a/repo', stats: [stat('dazzyd', 2)] },
        { repoName: 'b/repo', stats: [stat('dazzyd', 3)] },
      ],
      {
        getUser: async login => ({ login, avatar_url: 'a', html_url: 'h' }),
        knownUsers: new Map(),
        aliases: { dazzyd: 'yukixz' },
      },
    )
    expect(collection.yukixz.total).toBe(5)
    expect(collection.yukixz.perRepo).toEqual({ 'a/repo': 2, 'b/repo': 3 })
  })

  it('skips null authors without dropping other contributors', async () => {
    const collection = await aggregateContributors(
      [{ repoName: 'a/repo', stats: [stat(null, 9), stat('Javran', 1)] }],
      {
        getUser: async login => ({ login, avatar_url: 'a', html_url: 'h' }),
        knownUsers: new Map(),
        aliases: {},
      },
    )
    expect(Object.keys(collection)).toEqual(['Javran'])
  })
})

interface Harness {
  deps: BuildDeps
  writes: Array<{ json: string; svg: string }>
}

const makeHarness = (overrides: Partial<BuildDeps> = {}): Harness => {
  const writes: Array<{ json: string; svg: string }> = []
  const deps: BuildDeps = {
    getRepos: async () => [{ full_name: 'poooi/poi' }],
    listCachedRepos: async () => [],
    loadRepoManifest: async () => [],
    saveRepoManifest: async () => true,
    loadCachedData: async () => null,
    getContributors: async () => [stat('Javran', 1)],
    getUser: async login => ({ login, avatar_url: `https://a/${login}`, html_url: `https://h/${login}` }),
    loadPreviousContributors: async () => [],
    refreshAvatars: async () => ({ images: new Map(), skipped: false }),
    buildSvg: async () => '<svg/>',
    writeDist: async (json, svg) => {
      writes.push({ json, svg })
    },
    log: () => {},
    warn: () => {},
    ...overrides,
  }
  return { deps, writes }
}

describe('runBuild', () => {
  it('retains archived repos (with underscores) and known users when discovery fails', async () => {
    const json = await (async () => {
      const { deps, writes } = makeHarness({
        getRepos: async () => {
          throw new Error('org API down')
        },
        listCachedRepos: async () => ['ruiii/poi_theme_paper_dark'],
        loadCachedData: async () => [stat('tester', 5)],
        getContributors: async () => [stat('tester', 5)],
        loadPreviousContributors: async () => [
          { login: 'tester', avatar_url: 'old-avatar', html_url: 'old-url' },
        ],
        getUser: async () => {
          throw new Error('profile down')
        },
      })
      const manifest = vi.fn(deps.saveRepoManifest)
      const result = await runBuild({ ...deps, saveRepoManifest: manifest })
      expect(manifest).not.toHaveBeenCalled()
      expect(result.repos).toContain('ruiii/poi_theme_paper_dark')
      expect(writes).toHaveLength(1)
      return JSON.parse(writes[0].json)
    })()
    const tester = json.find(
      (entry: { login: string }) => entry.login === 'tester',
    )
    expect(tester.avatar_url).toBe('old-avatar')
    expect(tester.perRepo).toHaveProperty('ruiii/poi_theme_paper_dark')
  })

  it('saves the discovered manifest when discovery succeeds', async () => {
    const save = vi.fn(async (_repos: string[]) => true)
    const { deps } = makeHarness({ saveRepoManifest: save })
    await runBuild(deps)
    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0]
    expect(saved).toContain('poooi/poi')
    MORE_REPO.forEach(repo => expect(saved).toContain(repo))
  })

  it('produces stable output across identical runs', async () => {
    const { deps, writes } = makeHarness()
    await runBuild(deps)
    await runBuild(deps)
    expect(writes).toHaveLength(2)
    expect(writes[0].json).toBe(writes[1].json)
    expect(writes[0].svg).toBe(writes[1].svg)
  })

  it('does not publish dist when SVG generation fails', async () => {
    const writeDist = vi.fn(async () => {})
    const { deps } = makeHarness({
      buildSvg: async () => {
        throw new Error('avatar fetch failed')
      },
      writeDist,
    })
    await expect(runBuild(deps)).rejects.toThrow('avatar fetch failed')
    expect(writeDist).not.toHaveBeenCalled()
  })

  it('refuses to overwrite a non-empty previous output when nothing is attributable', async () => {
    const writeDist = vi.fn(async () => {})
    const { deps } = makeHarness({
      getContributors: async () => [stat(null, 5)],
      loadPreviousContributors: async () => [
        { login: 'tester', avatar_url: 'old-avatar', html_url: 'old-url' },
      ],
      writeDist,
    })
    await expect(runBuild(deps)).rejects.toThrow(/refusing to overwrite/i)
    expect(writeDist).not.toHaveBeenCalled()
  })

  it('applies overrides only to collected contributors, never inventing one', async () => {
    const { deps, writes } = makeHarness({
      getContributors: async () => [stat('Astra-RX', 1)],
    })
    await runBuild(deps)
    const json = JSON.parse(writes[0].json) as Array<{ login: string; html_url: string }>
    const astra = json.find(entry => entry.login === 'Astra-RX')
    expect(astra?.html_url).toBe(OVERWRITES['Astra-RX'].html_url)
    // A different override key was not collected, so it must not appear.
    expect(json.some(entry => entry.login === 'Chibaheit')).toBe(false)
  })

  it('refreshes avatars and reuses their images for graph.svg', async () => {
    const archiveImage = Buffer.from('archived-image')
    const refreshAvatars = vi.fn(async () => ({
      images: new Map([['https://a/Javran', archiveImage]]),
      skipped: false,
    }))
    const buildSvg = vi.fn(async () => '<svg/>')
    const { deps, writes } = makeHarness({ refreshAvatars, buildSvg })
    await runBuild(deps)

    expect(refreshAvatars).toHaveBeenCalledTimes(1)
    expect(buildSvg).toHaveBeenCalledWith(expect.any(Array), expect.any(Map), false)
    expect(writes).toHaveLength(1)
  })

  it('tells buildSvg when the avatar refresh was skipped', async () => {
    const buildSvg = vi.fn(async () => '<svg/>')
    const { deps } = makeHarness({
      refreshAvatars: async () => ({ images: new Map(), skipped: true }),
      buildSvg,
    })
    await runBuild(deps)
    expect(buildSvg).toHaveBeenCalledWith(expect.any(Array), expect.any(Map), true)
  })
})
