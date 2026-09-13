import { Octokit } from '@octokit/rest'
import childProcess from 'child_process'
import { promisify } from 'util'
import { saveCachedData } from './cache'
import { Repo, Stat, Week } from './types'

const execFile = promisify(childProcess.execFile)

// Minimal structural client shape so tests can inject a fake without depending
// on the full Octokit type.
export interface StatsResponse {
  status: number
  data: unknown
}

export interface RequestSignal {
  request?: { signal?: AbortSignal }
}

export interface OctokitLike {
  rest: {
    repos: {
      getContributorsStats: (args: {
        owner: string
        repo: string
      } & RequestSignal) => Promise<StatsResponse>
      listForOrg: unknown
    }
    users: {
      getByUsername: (args: {
        username: string
      } & RequestSignal) => Promise<{ data: unknown }>
    }
  }
  paginate: (method: unknown, args: unknown) => Promise<unknown[]>
}

// Resolve a token lazily. Environment tokens take priority so CI (which sets
// GITHUB_TOKEN/GH_TOKEN) never shells out. The local `gh` fallback is only
// attempted when both environment variables are absent.
export const resolveToken = async (): Promise<string | undefined> => {
  const envToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
  if (envToken) {
    return envToken
  }

  try {
    const { stdout } = await execFile('gh', ['auth', 'token'])
    const token = stdout.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

let octokitPromise: Promise<Octokit> | undefined

export const getOctokit = (): Promise<Octokit> => {
  if (!octokitPromise) {
    octokitPromise = resolveToken().then(
      token => new Octokit(token ? { auth: token } : {}),
    )
  }
  return octokitPromise
}

const asClient = async (octokit?: OctokitLike): Promise<OctokitLike> => {
  if (octokit) {
    return octokit
  }
  return (await getOctokit()) as unknown as OctokitLike
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isValidWeek = (value: unknown): value is Week =>
  isRecord(value) &&
  isFiniteNonNegative(value.w) &&
  isFiniteNonNegative(value.a) &&
  isFiniteNonNegative(value.d) &&
  isFiniteNonNegative(value.c)

// A payload that does not match the documented stats shape is not a transient
// network problem, so it must never be retried or allowed to overwrite a valid
// historical archive.
export class MalformedPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedPayloadError'
  }
}

// Validate the raw stats payload at the API boundary before it is trusted or
// archived. GitHub returns HTTP 202 with an empty object while stats are still
// being computed; that is handled by the retry loop, not here.
export const isValidStat = (value: unknown): value is Stat => {
  if (!isRecord(value)) {
    return false
  }
  if (!isFiniteNonNegative(value.total) || !Array.isArray(value.weeks)) {
    return false
  }
  if (!value.weeks.every(isValidWeek)) {
    return false
  }
  const author = value.author
  if (author === null) {
    return true
  }
  return (
    isRecord(author) &&
    typeof author.login === 'string' &&
    author.login.trim().length > 0
  )
}

export const validateContributorsPayload = (data: unknown): Stat[] => {
  if (!Array.isArray(data)) {
    throw new MalformedPayloadError('Malformed contributors payload: expected an array')
  }
  const invalidIndex = data.findIndex(entry => !isValidStat(entry))
  if (invalidIndex >= 0) {
    throw new MalformedPayloadError(
      `Malformed contributors payload: invalid entry at index ${invalidIndex}`,
    )
  }
  return data as Stat[]
}

export interface RetryConfig {
  retries: number
  minTimeout: number
  maxTimeout: number
  factor: number
  totalBudgetMs: number
  requestTimeoutMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
}

// Tuned for a daily refresh: a handful of quick retries within a small per-repo
// budget. GitHub 202 (stats still computing) is expected to recover across
// scheduled runs, so there is no point in blocking a single build for long.
export const defaultRetryConfig: RetryConfig = {
  retries: 4,
  minTimeout: 3000,
  maxTimeout: 15000,
  factor: 2,
  totalBudgetMs: 60 * 1000,
  requestTimeoutMs: 30 * 1000,
  sleep: ms =>
    new Promise(resolve => {
      setTimeout(resolve, ms)
    }),
  now: () => Date.now(),
}

const getStatus = (error: unknown): number | undefined => {
  const err = error as { status?: number; response?: { status?: number } }
  return err?.status ?? err?.response?.status
}

const getHeaders = (
  error: unknown,
): Record<string, string | number | undefined> | undefined => {
  const err = error as {
    response?: { headers?: Record<string, string | number | undefined> }
    headers?: Record<string, string | number | undefined>
  }
  return err?.response?.headers ?? err?.headers
}

// Decide whether an API error is worth retrying. 202 means stats are still
// being computed; 403/429 and 5xx/network errors are transient (rate limits
// and outages). 404/401/422 and malformed payloads are not retried.
export const isRetryableGithubError = (error: unknown): boolean => {
  if (error instanceof MalformedPayloadError) {
    return false
  }
  const status = getStatus(error)
  if (status === undefined) {
    return true
  }
  if (status === 202 || status === 403 || status === 408 || status === 429) {
    return true
  }
  return status >= 500
}

// Honor Retry-After (seconds or HTTP date) and X-RateLimit-Reset (epoch
// seconds) when present, otherwise fall back to exponential backoff.
export const getRetryDelayMs = (
  error: unknown,
  attempt: number,
  config: RetryConfig,
): number | undefined => {
  const headers = getHeaders(error)
  const retryAfter = headers?.['retry-after']
  if (retryAfter !== undefined && retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000
    }
    const timestamp = Date.parse(String(retryAfter))
    if (!Number.isNaN(timestamp)) {
      return Math.max(0, timestamp - config.now())
    }
  }

  const reset = headers?.['x-ratelimit-reset']
  if (reset !== undefined && reset !== null) {
    const resetMs = Number(reset) * 1000
    if (Number.isFinite(resetMs)) {
      return Math.max(0, resetMs - config.now())
    }
  }

  return Math.min(config.maxTimeout, config.minTimeout * config.factor ** attempt)
}

// Attach a real AbortSignal to the underlying request so a timeout actually
// cancels the in-flight HTTP call instead of merely racing it from the outside.
const withRequestTimeout = async <T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await run(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`GitHub request timed out after ${ms}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// Bounded retry loop. Both the time spent sleeping and the wall-clock elapsed
// time (including request time) are bounded by totalBudgetMs, so a slow or
// hostile server cannot stall a build indefinitely. The callback receives the
// timeout for that attempt, which is capped by the remaining budget so no
// request can outlive the deadline.
export const withBoundedRetry = async <T>(
  fn: (attempt: number, requestTimeoutMs: number) => Promise<T>,
  config: RetryConfig,
  isRetryable: (error: unknown) => boolean = isRetryableGithubError,
): Promise<T> => {
  const startedAt = config.now()
  let attempt = 0

  for (;;) {
    const remaining = config.totalBudgetMs - (config.now() - startedAt)
    if (remaining <= 0) {
      throw new Error(
        `GitHub request budget of ${config.totalBudgetMs}ms exhausted`,
      )
    }
    try {
      return await fn(attempt, Math.min(config.requestTimeoutMs, remaining))
    } catch (error) {
      const elapsed = config.now() - startedAt
      if (
        !isRetryable(error) ||
        attempt >= config.retries ||
        elapsed >= config.totalBudgetMs
      ) {
        throw error
      }
      const delay = getRetryDelayMs(error, attempt, config) ?? 0
      if (elapsed + delay > config.totalBudgetMs) {
        throw error
      }
      await config.sleep(delay)
      attempt += 1
    }
  }
}

const fetchContributorStats = async (
  client: OctokitLike,
  owner: string,
  repo: string,
  requestTimeoutMs: number,
): Promise<Stat[]> => {
  const response = await withRequestTimeout(requestTimeoutMs, signal =>
    client.rest.repos.getContributorsStats({
      owner,
      repo,
      request: { signal },
    }),
  )
  if (response.status === 202) {
    throw Object.assign(new Error('Stats being computed (202)'), { status: 202 })
  }
  return validateContributorsPayload(response.data)
}

export interface GetContributorsOptions {
  octokit?: OctokitLike
  previous?: Stat[] | null
  retry?: Partial<RetryConfig>
  save?: (repoFullName: string, data: Stat[]) => Promise<unknown>
}

// Always refresh from GitHub on a normal build, but never replace valid
// historical data with a failure, empty or malformed response. The previous
// archive (if any) is returned as a fallback. Archive persistence failures
// propagate so the build fails loudly instead of pretending success.
export const getContributors = async (
  owner: string,
  repo: string,
  options: GetContributorsOptions = {},
): Promise<Stat[]> => {
  const repoFullName = `${owner}/${repo}`
  const previous = options.previous ?? null
  const client = await asClient(options.octokit)
  const config: RetryConfig = { ...defaultRetryConfig, ...options.retry }
  const save = options.save ?? saveCachedData

  let data: Stat[]
  try {
    data = await withBoundedRetry(
      (_attempt, requestTimeoutMs) =>
        fetchContributorStats(client, owner, repo, requestTimeoutMs),
      config,
    )
  } catch (error) {
    console.error(`[ERROR] failed to refresh ${repoFullName}:`, error)
    if (previous && previous.length > 0) {
      console.warn(`⚠️  keeping previous archived stats for ${repoFullName}`)
      return previous
    }
    return previous ?? []
  }

  if (data.length === 0) {
    console.warn(`⚠️  empty data for ${repoFullName}; keeping previous archive`)
    return previous && previous.length > 0 ? previous : []
  }

  // GitHub can return null-author entries that hide identities which were
  // previously attributable (e.g. account renames/deletions). If that hides a
  // contributor we already know about, keep the entire previous snapshot rather
  // than mixing fresh totals heuristically.
  const knownLogins = new Set(
    (previous ?? []).filter(stat => stat.author).map(stat => stat.author!.login),
  )
  const freshLogins = new Set(
    data.filter(stat => stat.author).map(stat => stat.author!.login),
  )
  const hasNullAuthors = data.some(stat => !stat.author)
  const lostIdentities = [...knownLogins].filter(login => !freshLogins.has(login))

  if (hasNullAuthors && lostIdentities.length > 0) {
    console.warn(
      `⚠️  ${repoFullName}: fresh data hides known contributor(s) (${lostIdentities.join(
        ', ',
      )}); keeping previous archived stats`,
    )
    return previous as Stat[]
  }

  if (hasNullAuthors) {
    console.warn(
      `⚠️  ${repoFullName}: ${data.filter(stat => !stat.author).length}/${
        data.length
      } contributors have null author (skipped when aggregating)`,
    )
  }

  await save(repoFullName, data)
  console.info(`✅ Refreshed ${data.length} contributors for ${repoFullName}`)
  return data
}

export const getRepos = async (octokit?: OctokitLike): Promise<Repo[]> => {
  const client = await asClient(octokit)
  const repos = await withRequestTimeout(
    defaultRetryConfig.requestTimeoutMs,
    signal =>
      client.paginate(client.rest.repos.listForOrg, {
        org: 'poooi',
        per_page: 100,
        request: { signal },
      }),
  )
  return repos as Repo[]
}

// Profile lookups run once per contributor and are best-effort, so they get a
// short timeout: a widespread outage must not let them dominate the job budget.
export const USER_REQUEST_TIMEOUT_MS = 5_000

export const getUser = async (
  login: string,
  octokit?: OctokitLike,
): Promise<Record<string, unknown> | null> => {
  const client = await asClient(octokit)
  try {
    const response = await withRequestTimeout(
      USER_REQUEST_TIMEOUT_MS,
      signal =>
        client.rest.users.getByUsername({
          username: login,
          request: { signal },
        }),
    )
    return (response.data as Record<string, unknown>) ?? null
  } catch (error) {
    if (getStatus(error) === 404) {
      return null
    }
    throw error
  }
}
