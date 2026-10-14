import { describe, expect, it, vi } from 'vitest'
import { MORE_REPO, OVERWRITES, OVERWRITES_BY_ID } from './config'
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

const bot = (login: string, type = 'Bot', total = 1): Stat => ({
  total,
  weeks: [week()],
  author: { login, type } as unknown as Stat['author'],
})

const statWithId = (login: string, id: number, total = 1): Stat => ({
  total,
  weeks: [week()],
  author: { login, id } as unknown as Stat['author'],
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

  it('never seeds a bot from the previous output', () => {
    const users = toKnownUsers([
      { login: 'chiba-bot', avatar_url: 'a', html_url: 'h' } as ContributorSimple,
      { login: 'github-actions[bot]', avatar_url: 'a', html_url: 'h' } as ContributorSimple,
      { login: 'Javran', avatar_url: 'a', html_url: 'h' } as ContributorSimple,
    ])
    expect([...users.keys()]).toEqual(['Javran'])
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

  it('excludes bots before profile lookup and from the collection', async () => {
    const getUser = vi.fn(async (login: string) => ({
      login,
      avatar_url: 'a',
      html_url: 'h',
    }))
    const collection = await aggregateContributors(
      [
        {
          repoName: 'a/repo',
          stats: [
            stat('Javran', 2),
            bot('some-app', 'Bot'),
            bot('CustomTool[bot]', 'User'),
            bot('chiba-bot', 'User'),
            bot('claude', 'User'),
          ],
        },
      ],
      { getUser, knownUsers: new Map(), aliases: {} },
    )
    expect(Object.keys(collection)).toEqual(['Javran'])
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith('Javran')
  })

  it('groups the same numeric ID across old and new login spellings', async () => {
    const collection = await aggregateContributors(
      [
        { repoName: 'a/repo', stats: [statWithId('OldName', 42, 2)] },
        { repoName: 'b/repo', stats: [statWithId('NewName', 42, 3)] },
      ],
      {
        getUser: async () => {
          throw new Error('must not look up an identified source by login')
        },
        knownUsers: new Map(),
        aliases: {},
        getUserById: async id => ({
          login: 'NewName',
          id,
          avatar_url: 'https://a/42',
          html_url: 'https://github.com/NewName',
        }),
      },
    )
    expect(Object.keys(collection)).toEqual(['NewName'])
    expect(collection.NewName).toMatchObject({
      id: 42,
      total: 5,
      perRepo: { 'a/repo': 2, 'b/repo': 3 },
    })
  })

  it('merges a curated numeric alias source ID into its explicit target ID', async () => {
    const getUserById = vi.fn(async (id: number) => ({
      login: id === 3337921 ? 'yukixz' : 'dazzyd',
      id,
      avatar_url: 'https://a',
      html_url: `https://github.com/${id}`,
    }))
    const collection = await aggregateContributors(
      [
        { repoName: 'a/repo', stats: [statWithId('dazzyd', 17616866, 2)] },
        { repoName: 'b/repo', stats: [statWithId('yukixz', 3337921, 3)] },
      ],
      {
        getUser: async () => {
          throw new Error('alias must not be resolved by username lookup')
        },
        knownUsers: new Map(),
        aliases: { dazzyd: 'yukixz' },
        accountAliases: { 17616866: 3337921 },
        getUserById,
      },
    )
    expect(Object.keys(collection)).toEqual(['yukixz'])
    expect(collection.yukixz.total).toBe(5)
    expect(getUserById).toHaveBeenCalledWith(3337921)
    expect(getUserById).not.toHaveBeenCalledWith(17616866)
  })

  it('does not merge different IDs that share a login, and warns', async () => {
    const warn = vi.fn()
    const collection = await aggregateContributors(
      [
        { repoName: 'a/repo', stats: [statWithId('Shared', 100, 2)] },
        { repoName: 'b/repo', stats: [statWithId('Shared', 200, 3)] },
      ],
      {
        getUser: async () => {
          throw new Error('must not look up an identified source by login')
        },
        knownUsers: new Map(),
        aliases: {},
        warn,
        getUserById: async id => ({
          login: 'Shared',
          id,
          avatar_url: 'https://a',
          html_url: `https://github.com/u${id}`,
        }),
      },
    )
    expect(
      Object.values(collection)
        .map(entry => entry.total)
        .sort((a, b) => a - b),
    ).toEqual([2, 3])
    expect(warn).toHaveBeenCalled()
  })

  it('falls back to ID-addressed data when the live lookup returns a mismatched ID', async () => {
    const warn = vi.fn()
    const collection = await aggregateContributors(
      [{ repoName: 'a/repo', stats: [statWithId('Ghost', 555, 4)] }],
      {
        getUser: async () => {
          throw new Error('must not look up an identified source by login')
        },
        knownUsers: new Map(),
        aliases: {},
        warn,
        getUserById: async () => ({
          login: 'Imposter',
          id: 999,
          avatar_url: 'https://evil/avatar.png',
          html_url: 'https://github.com/Imposter',
        }),
      },
    )
    expect(collection.Ghost).toMatchObject({
      id: 555,
      login: 'Ghost',
      total: 4,
      html_url: 'https://github.com/',
      avatar_url: 'https://avatars.githubusercontent.com/u/555?v=4',
    })
    expect(warn).toHaveBeenCalled()
  })

  it('preserves contributions with a neutral link for a deleted (404) ID', async () => {
    const collection = await aggregateContributors(
      [{ repoName: 'a/repo', stats: [statWithId('Gone', 777, 6)] }],
      {
        getUser: async () => {
          throw new Error('must not look up an identified source by login')
        },
        knownUsers: new Map(),
        aliases: {},
        getUserById: async () => null,
      },
    )
    expect(collection.Gone).toMatchObject({
      total: 6,
      html_url: 'https://github.com/',
      avatar_url: 'https://avatars.githubusercontent.com/u/777?v=4',
    })
  })

  it('never treats a transient lookup failure as deletion and retries each build', async () => {
    const getUserById = vi.fn(async () => {
      throw { status: 500 }
    })
    const collection = await aggregateContributors(
      [{ repoName: 'a/repo', stats: [statWithId('Flaky', 888, 7)] }],
      {
        getUser: async () => {
          throw new Error('must not look up an identified source by login')
        },
        knownUsers: new Map(),
        aliases: {},
        getUserById,
      },
    )
    expect(collection.Flaky.total).toBe(7)
    expect(collection.Flaky.html_url).toBe('https://github.com/')
    expect(getUserById).toHaveBeenCalledWith(888)
  })

  it('uses a matching-ID known profile for name/login but never a wrong-ID avatar', async () => {
    const collection = await aggregateContributors(
      [{ repoName: 'a/repo', stats: [statWithId('OldLogin', 321, 1)] }],
      {
        getUser: async () => {
          throw new Error('must not look up an identified source by login')
        },
        knownUsers: new Map(),
        knownUsersById: new Map([
          [
            321,
            {
              login: 'KnownLogin',
              name: 'Known Name',
              id: 321,
              avatar_url: 'https://evil/wrong.png',
              html_url: 'https://github.com/KnownLogin',
            },
          ],
        ]),
        aliases: {},
        getUserById: async () => null,
      },
    )
    expect(collection.KnownLogin).toMatchObject({
      id: 321,
      name: 'Known Name',
      avatar_url: 'https://avatars.githubusercontent.com/u/321?v=4',
      html_url: 'https://github.com/',
    })
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
    getUserById: async id => ({
      login: `user${id}`,
      id,
      avatar_url: `https://a/${id}`,
      html_url: `https://github.com/user${id}`,
    }),
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
      getContributors: async () => [stat('Chibaheit', 1)],
    })
    await runBuild(deps)
    const json = JSON.parse(writes[0].json) as Array<{ login: string; html_url: string }>
    const chiba = json.find(entry => entry.login === 'Chibaheit')
    expect(chiba?.html_url).toBe(OVERWRITES['Chibaheit'].html_url)
    // A different override key was not collected, so it must not appear.
    expect(json.some(entry => entry.login === 'Artoria9')).toBe(false)
  })

  it('pins overrides by numeric ID so they follow a legitimate rename', async () => {
    const { deps, writes } = makeHarness({
      getContributors: async () => [statWithId('Artoria9', 1183568, 1)],
      getUserById: async id => ({
        login: 'Artoria9',
        id,
        avatar_url: 'https://a/1',
        html_url: 'https://github.com/Artoria9',
      }),
    })
    await runBuild(deps)
    const json = JSON.parse(writes[0].json) as Array<{ login: string; html_url: string }>
    expect(json.find(entry => entry.login === 'Artoria9')?.html_url).toBe(
      OVERWRITES_BY_ID[1183568].html_url,
    )
  })

  it('never lets a recycled login inherit a pinned override', async () => {
    const { deps, writes } = makeHarness({
      getContributors: async () => [statWithId('Artoria9', 999999, 1)],
      getUserById: async id => ({
        login: 'Artoria9',
        id,
        avatar_url: 'https://a/1',
        html_url: 'https://github.com/Artoria9',
      }),
    })
    await runBuild(deps)
    const json = JSON.parse(writes[0].json) as Array<{ login: string; html_url: string }>
    // Same login, different ID: the curated weibo link must not be inherited.
    expect(json.find(entry => entry.login === 'Artoria9')?.html_url).toBe(
      'https://github.com/Artoria9',
    )
  })

  it('does not let an unresolved ID re-acquire a github username override link', async () => {
    const { deps, writes } = makeHarness({
      getContributors: async () => [statWithId('hanzhao', 6753092, 1)],
      getUserById: async () => null,
    })
    await runBuild(deps)
    const json = JSON.parse(writes[0].json) as Array<{ login: string; html_url: string }>
    expect(json.find(entry => entry.login === 'hanzhao')?.html_url).toBe(
      'https://github.com/',
    )
  })

  it('never publishes bots even if a collector returns them', async () => {
    const { deps, writes } = makeHarness({
      getContributors: async () => [
        stat('Javran', 1),
        bot('github-actions[bot]'),
        bot('chiba-bot', 'User'),
      ],
    })
    await runBuild(deps)
    const json = JSON.parse(writes[0].json) as Array<{ login: string }>
    const logins = json.map(entry => entry.login)
    expect(logins).toContain('Javran')
    expect(logins).not.toContain('github-actions[bot]')
    expect(logins).not.toContain('chiba-bot')
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
