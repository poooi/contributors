import fs from 'fs-extra'
import os from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getContributors,
  getRepos,
  getRetryDelayMs,
  getUser,
  isRetryableGithubError,
  isValidStat,
  MalformedPayloadError,
  OctokitLike,
  resolveToken,
  RetryConfig,
  validateContributorsPayload,
  withBoundedRetry,
} from './github'
import { loadCachedData, saveCachedData } from './cache'
import { Stat, Week } from './types'

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

const botStat = (login: string, type = 'Bot', total = 1): Stat => ({
  total,
  weeks: [week()],
  author: { login, type } as unknown as Stat['author'],
})

interface FakeOptions {
  getContributorsStats?: (args: {
    owner: string
    repo: string
    request?: { signal?: AbortSignal }
  }) => Promise<{
    status: number
    data: unknown
  }>
  getByUsername?: (args: {
    username: string
    request?: { signal?: AbortSignal }
  }) => Promise<{ data: unknown }>
  repos?: unknown[]
}

// A fake that never resolves until its request signal is aborted, mirroring how
// Octokit's fetch propagates the AbortSignal.
const abortable = (signal?: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    )
  })

const makeClient = (options: FakeOptions = {}): OctokitLike => ({
  rest: {
    repos: {
      getContributorsStats:
        options.getContributorsStats ??
        (async () => ({ status: 200, data: [stat('Javran')] })),
      listForOrg: {},
    },
    users: {
      getByUsername:
        options.getByUsername ?? (async () => ({ data: { login: 'Javran' } })),
    },
  },
  paginate: async () => options.repos ?? [{ full_name: 'poooi/poi' }],
})

const fastRetry = (overrides: Partial<RetryConfig> = {}): Partial<RetryConfig> => ({
  retries: 2,
  minTimeout: 0,
  maxTimeout: 0,
  factor: 2,
  totalBudgetMs: 1000,
  requestTimeoutMs: 1000,
  sleep: async () => {},
  now: () => 0,
  ...overrides,
})

describe('payload validation', () => {
  it('accepts well-formed stats including null authors', () => {
    expect(isValidStat(stat('a'))).toBe(true)
    expect(isValidStat(stat(null))).toBe(true)
  })

  it('rejects malformed totals and weeks', () => {
    expect(isValidStat({ total: '1', weeks: [week()], author: stat('a').author })).toBe(false)
    expect(isValidStat({ total: -1, weeks: [week()], author: stat('a').author })).toBe(false)
    expect(isValidStat({ total: Infinity, weeks: [week()], author: stat('a').author })).toBe(false)
    expect(
      isValidStat({
        total: 1,
        weeks: [{ w: 1, a: 1, d: 0 }],
        author: stat('a').author,
      }),
    ).toBe(false)
    expect(
      isValidStat({ total: 1, weeks: [{ w: 1, a: 1, d: 0, c: -2 }], author: stat('a').author }),
    ).toBe(false)
  })

  it('rejects empty author logins and non-arrays', () => {
    expect(
      isValidStat({ total: 1, weeks: [week()], author: { login: '  ' } }),
    ).toBe(false)
    expect(() => validateContributorsPayload({})).toThrow(MalformedPayloadError)
  })
})

describe('token resolution', () => {
  const originalGh = process.env.GH_TOKEN
  const originalGithub = process.env.GITHUB_TOKEN

  afterEach(() => {
    if (originalGh === undefined) {
      delete process.env.GH_TOKEN
    } else {
      process.env.GH_TOKEN = originalGh
    }
    if (originalGithub === undefined) {
      delete process.env.GITHUB_TOKEN
    } else {
      process.env.GITHUB_TOKEN = originalGithub
    }
  })

  it('prefers GH_TOKEN, then GITHUB_TOKEN', async () => {
    process.env.GH_TOKEN = 'gh-token'
    process.env.GITHUB_TOKEN = 'github-token'
    expect(await resolveToken()).toBe('gh-token')
    delete process.env.GH_TOKEN
    expect(await resolveToken()).toBe('github-token')
  })
})

describe('retry classification', () => {
  it('retries 202, rate limits, 5xx and network errors, but not malformed payloads', () => {
    expect(isRetryableGithubError({ status: 202 })).toBe(true)
    expect(isRetryableGithubError({ status: 403 })).toBe(true)
    expect(isRetryableGithubError({ status: 429 })).toBe(true)
    expect(isRetryableGithubError({ status: 503 })).toBe(true)
    expect(isRetryableGithubError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableGithubError({ status: 404 })).toBe(false)
    expect(isRetryableGithubError(new MalformedPayloadError('bad'))).toBe(false)
  })

  it('honors Retry-After seconds and X-RateLimit-Reset', () => {
    const config = fastRetry() as RetryConfig
    expect(
      getRetryDelayMs({ response: { headers: { 'retry-after': '2' } } }, 0, config),
    ).toBe(2000)
    expect(
      getRetryDelayMs(
        { response: { headers: { 'x-ratelimit-reset': '5' } } },
        0,
        { ...config, now: () => 0 },
      ),
    ).toBe(5000)
  })
})

describe('bounded retry', () => {
  it('stops retrying once the wall-clock budget is exhausted', async () => {
    const sleep = vi.fn(async () => {})
    const config = {
      ...fastRetry(),
      retries: 10,
      totalBudgetMs: 100,
      sleep,
      now: () => 0,
    } as RetryConfig
    let calls = 0
    await expect(
      withBoundedRetry(
        async () => {
          calls += 1
          throw { status: 403, response: { headers: { 'retry-after': '5000' } } }
        },
        config,
      ),
    ).rejects.toBeTruthy()
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('caps each attempt timeout by the remaining budget', async () => {
    let nowValue = 0
    const attemptTimeouts: number[] = []
    const config = {
      ...fastRetry(),
      retries: 10,
      totalBudgetMs: 50,
      requestTimeoutMs: 1000,
      now: () => nowValue,
      sleep: async () => {},
    } as RetryConfig

    await expect(
      withBoundedRetry(async (_attempt, requestTimeoutMs) => {
        attemptTimeouts.push(requestTimeoutMs)
        nowValue += 30
        throw { status: 500 }
      }, config),
    ).rejects.toBeTruthy()

    expect(attemptTimeouts).toEqual([50, 20])
  })

  it('never starts a request at or after the deadline', async () => {
    let nowValue = 0
    const attemptTimeouts: number[] = []
    const config = {
      ...fastRetry(),
      retries: 5,
      totalBudgetMs: 100,
      requestTimeoutMs: 1000,
      now: () => nowValue,
      sleep: async (ms: number) => {
        nowValue += ms
      },
    } as RetryConfig

    await expect(
      withBoundedRetry(async (_attempt, requestTimeoutMs) => {
        attemptTimeouts.push(requestTimeoutMs)
        nowValue += 50
        throw {
          status: 403,
          response: { headers: { 'retry-after': '0.05' } },
        }
      }, config),
    ).rejects.toThrow('budget')

    expect(attemptTimeouts).toEqual([100])
  })
})

describe('getContributors refresh behaviour', () => {
  it('refreshes over the archive and saves the fresh stats', async () => {
    const fresh = [stat('Javran', 9)]
    const client = makeClient({ getContributorsStats: async () => ({ status: 200, data: fresh }) })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'poi-plugin-mo2', {
      octokit: client,
      previous: [stat('Javran', 1)],
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual(fresh)
    expect(save).toHaveBeenCalledWith('Javran/poi-plugin-mo2', fresh)
  })

  it('keeps historical stats when 202 retries are exhausted', async () => {
    const previous = [stat('Javran', 5)]
    const client = makeClient({ getContributorsStats: async () => ({ status: 202, data: {} }) })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'poi-plugin-mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual(previous)
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps historical stats on server errors', async () => {
    const previous = [stat('Javran', 5)]
    const client = makeClient({
      getContributorsStats: async () => {
        throw { status: 500 }
      },
    })
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save: vi.fn(async () => true),
    })
    expect(result).toEqual(previous)
  })

  it('honors Retry-After before succeeding', async () => {
    const sleep = vi.fn(async () => {})
    const client = makeClient({
      getContributorsStats: vi
        .fn()
        .mockRejectedValueOnce({ status: 403, response: { headers: { 'retry-after': '2' } } })
        .mockResolvedValueOnce({ status: 200, data: [stat('Javran', 3)] }),
    })
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      retry: fastRetry({ sleep, totalBudgetMs: 10_000 }),
      save: vi.fn(async () => true),
    })
    expect(result).toEqual([stat('Javran', 3)])
    expect(sleep).toHaveBeenCalledWith(2000)
  })

  it('does not retry malformed payloads and keeps the archive', async () => {
    const getStats = vi.fn(async () => ({
      status: 200,
      data: [{ total: 'nope', weeks: [], author: null }],
    }))
    const client = makeClient({ getContributorsStats: getStats })
    const previous = [stat('Javran', 5)]
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry({ retries: 5 }),
      save: vi.fn(async () => true),
    })
    expect(result).toEqual(previous)
    expect(getStats).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite the archive with an empty response', async () => {
    const save = vi.fn(async () => true)
    const client = makeClient({ getContributorsStats: async () => ({ status: 200, data: [] }) })
    const previous = [stat('Javran', 5)]
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual(previous)
    expect(save).not.toHaveBeenCalled()
  })

  it('fails the build when persisting fresh stats fails', async () => {
    const client = makeClient({
      getContributorsStats: async () => ({ status: 200, data: [stat('Javran', 3)] }),
    })
    await expect(
      getContributors('Javran', 'mo2', {
        octokit: client,
        retry: fastRetry(),
        save: async () => {
          throw new Error('disk full')
        },
      }),
    ).rejects.toThrow('disk full')
  })

  it('keeps the whole previous snapshot when fresh null authors hide known identities', async () => {
    const previous = [stat('Javran', 5), stat(null, 2)]
    const client = makeClient({
      getContributorsStats: async () => ({ status: 200, data: [stat(null, 8)] }),
    })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual(previous)
    expect(save).not.toHaveBeenCalled()
  })

  it('accepts fresh data containing null authors when no identity is lost', async () => {
    const fresh = [stat(null, 8), stat('Javran', 1)]
    const save = vi.fn(async () => true)
    const client = makeClient({ getContributorsStats: async () => ({ status: 200, data: fresh }) })
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous: null,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual(fresh)
    expect(save).toHaveBeenCalledWith('Javran/mo2', fresh)
  })

  it('aborts the underlying request when it exceeds the request timeout', async () => {
    let signal: AbortSignal | undefined
    const client = makeClient({
      getContributorsStats: args => {
        signal = args.request?.signal
        return abortable(args.request?.signal)
      },
    })
    const previous = [stat('Javran', 5)]
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry({ retries: 0, requestTimeoutMs: 10 }),
      save: vi.fn(async () => true),
    })
    expect(result).toEqual(previous)
    expect(signal?.aborted).toBe(true)
  })

  it('excludes bots before persisting the archive', async () => {
    const human = stat('Javran', 5)
    const fresh = [
      human,
      botStat('github-actions[bot]'),
      botStat('some-app', 'Bot'),
      botStat('CustomTool[bot]', 'User'),
      botStat('chiba-bot', 'User'),
      botStat('claude', 'User'),
    ]
    const client = makeClient({
      getContributorsStats: async () => ({ status: 200, data: fresh }),
    })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual([human])
    expect(save).toHaveBeenCalledWith('Javran/mo2', [human])
  })

  it('drops legacy bot rows from the failure fallback', async () => {
    const previous = [stat('Javran', 5), botStat('github-actions[bot]', 'Bot', 15)]
    const client = makeClient({
      getContributorsStats: async () => {
        throw { status: 500 }
      },
    })
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save: vi.fn(async () => true),
    })
    expect(result).toEqual([previous[0]])
  })

  it('persists an empty archive for an all-bot repo', async () => {
    const client = makeClient({
      getContributorsStats: async () => ({
        status: 200,
        data: [botStat('github-actions[bot]', 'Bot', 15)],
      }),
    })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous: [botStat('github-actions[bot]', 'Bot', 14)],
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual([])
    expect(save).toHaveBeenCalledWith('Javran/mo2', [])
  })

  it('preserves previous humans when a fresh payload filters to zero', async () => {
    const previous = [stat('Javran', 5), botStat('github-actions[bot]', 'Bot', 14)]
    const client = makeClient({
      getContributorsStats: async () => ({
        status: 200,
        data: [botStat('github-actions[bot]', 'Bot', 15)],
      }),
    })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual([previous[0]])
    expect(save).not.toHaveBeenCalled()
  })

  it('does not freeze a human refresh when a bot disappears with null authors', async () => {
    const previous = [stat('Javran', 5), botStat('github-actions[bot]', 'Bot', 15)]
    const fresh = [stat('Javran', 6), stat(null, 1)]
    const client = makeClient({
      getContributorsStats: async () => ({ status: 200, data: fresh }),
    })
    const save = vi.fn(async () => true)
    const result = await getContributors('Javran', 'mo2', {
      octokit: client,
      previous,
      retry: fastRetry(),
      save,
    })
    expect(result).toEqual(fresh)
    expect(save).toHaveBeenCalledWith('Javran/mo2', fresh)
  })

  it('does not rewrite the archive when only bot totals change', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'contributors-bot-'))
    try {
      const human = stat('Javran', 5)
      const changes: boolean[] = []
      const save = async (name: string, data: Stat[]) => {
        const changed = await saveCachedData(name, data, dir)
        changes.push(changed)
        return changed
      }

      const first = makeClient({
        getContributorsStats: async () => ({
          status: 200,
          data: [human, botStat('github-actions[bot]', 'Bot', 14)],
        }),
      })
      await getContributors('poooi', 'poi', {
        octokit: first,
        previous: null,
        retry: fastRetry(),
        save,
      })
      const archived = await loadCachedData('poooi/poi', dir)
      expect(archived).toEqual([human])

      const second = makeClient({
        getContributorsStats: async () => ({
          status: 200,
          data: [human, botStat('github-actions[bot]', 'Bot', 15)],
        }),
      })
      const result = await getContributors('poooi', 'poi', {
        octokit: second,
        previous: archived,
        retry: fastRetry(),
        save,
      })
      expect(result).toEqual([human])
      // First run wrote the human archive; the bot-only increase was a no-op.
      expect(changes).toEqual([true, false])
    } finally {
      await fs.remove(dir)
    }
  })
})

describe('getRepos and getUser', () => {
  it('paginates org repos', async () => {
    const client = makeClient({ repos: [{ full_name: 'poooi/poi' }] })
    expect(await getRepos(client)).toEqual([{ full_name: 'poooi/poi' }])
  })

  it('passes an abort signal to pagination and user lookups', async () => {
    let paginateSignal: AbortSignal | undefined
    let userSignal: AbortSignal | undefined
    const client = makeClient()
    client.paginate = async (_method, args) => {
      paginateSignal = (args as { request?: { signal?: AbortSignal } }).request
        ?.signal
      return [{ full_name: 'poooi/poi' }]
    }
    client.rest.users.getByUsername = async args => {
      userSignal = args.request?.signal
      return { data: { login: 'Javran' } }
    }

    await getRepos(client)
    await getUser('Javran', client)

    expect(paginateSignal).toBeInstanceOf(AbortSignal)
    expect(userSignal).toBeInstanceOf(AbortSignal)
  })

  it('returns null for missing users and throws for other errors', async () => {
    const missing = makeClient({
      getByUsername: async () => {
        throw { status: 404 }
      },
    })
    expect(await getUser('ghost', missing)).toBeNull()

    const broken = makeClient({
      getByUsername: async () => {
        throw { status: 500 }
      },
    })
    await expect(getUser('ghost', broken)).rejects.toBeTruthy()
  })
})
