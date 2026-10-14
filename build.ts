import bluebird from 'bluebird'
import chalk from 'chalk'
import fs from 'fs-extra'
import _ from 'lodash'
import { join } from 'path'

import {
  ACCOUNT_ALIAS,
  ALIAS,
  IGNORED_REPO,
  isExcludedContributor,
  isExcludedLogin,
  MORE_PEOPLE,
  MORE_REPO,
  OVERWRITES,
  OVERWRITES_BY_ID,
} from './config'
import {
  getContributors as fetchContributors,
  getRepos,
  getUser,
  getUserById,
} from './github'
import {
  CACHE_DIR,
  listCachedRepos,
  loadCachedData,
  loadRepoManifest,
  saveCachedData,
  saveRepoManifest,
} from './cache'
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_DIST_DIR,
  refreshAvatars,
  renderCircleBase64,
  renderPlaceholderBase64,
} from './avatars'
import { SUPPORTERS_ARCHIVE_PATH } from './opencollective'
import {
  Contributor,
  ContributorCollection,
  ContributorSimple,
  Repo,
  Stat,
  UserProfile,
  Week,
} from './types'
import { buildSvg, getFirstCommitTime, getImage, reduceStat } from './utils'

const distDir = join(__dirname, 'dist')

// Bound how many repos are refreshed at once so a widespread 202/outage still
// finishes well within the workflow's job timeout.
const MAX_CONCURRENCY = 4

export const splitRepo = (fullName: string): [string, string] | null => {
  const index = fullName.indexOf('/')
  if (index <= 0 || index === fullName.length - 1) {
    return null
  }
  return [fullName.slice(0, index), fullName.slice(index + 1)]
}

export interface ResolveRepoListInput {
  discovered: Repo[]
  archived: string[]
  manifest: string[]
  extra: string[]
  ignored: string[]
}

// Merge freshly discovered org repos with everything we already know about
// (archives + manifest + curated extras). A failed discovery therefore never
// means "these repos were deleted"; it just means we fall back to the list we
// already have.
export const resolveRepoList = (input: ResolveRepoListInput): string[] => {
  const names = new Set<string>()
  input.discovered.forEach(repo => names.add(repo.full_name))
  input.archived.forEach(name => names.add(name))
  input.manifest.forEach(name => names.add(name))
  input.extra.forEach(name => names.add(name))
  return [...names].filter(name => !input.ignored.includes(name)).sort()
}

// Build a lookup of users seen in previous output so a failed profile lookup
// does not drop an otherwise known contributor.
export const toKnownUsers = (
  previous: ContributorSimple[],
): Map<string, UserProfile> => {
  const users = new Map<string, UserProfile>()
  previous.forEach(entry => {
    if (!entry || typeof entry.login !== 'string') {
      return
    }
    if (isExcludedLogin(entry.login)) {
      return
    }
    const detailed = entry as unknown as Partial<Contributor>
    users.set(entry.login, {
      login: entry.login,
      name: detailed.name,
      id: detailed.id,
      avatar_url: entry.avatar_url,
      html_url: entry.html_url,
    })
  })
  return users
}

// Build a lookup of previously published users by stable numeric ID. This is
// the only safe profile fallback for an identified contributor: a login-keyed
// lookup could now belong to a different (recycled) account.
export const toKnownUsersById = (
  previous: ContributorSimple[],
): Map<number, UserProfile> => {
  const users = new Map<number, UserProfile>()
  previous.forEach(entry => {
    if (!entry || typeof entry.login !== 'string') {
      return
    }
    if (isExcludedLogin(entry.login)) {
      return
    }
    const detailed = entry as unknown as Partial<Contributor>
    if (typeof detailed.id !== 'number' || !Number.isFinite(detailed.id)) {
      return
    }
    users.set(detailed.id, {
      login: entry.login,
      name: detailed.name,
      id: detailed.id,
      avatar_url: entry.avatar_url,
      html_url: entry.html_url,
    })
  })
  return users
}

export interface RepoStats {
  repoName: string
  stats: Stat[]
}

export interface AggregateOptions {
  getUser: (login: string) => Promise<Record<string, unknown> | null>
  knownUsers: Map<string, UserProfile>
  aliases: Record<string, string>
  // Identity-aware inputs. They are optional so callers without stable IDs keep
  // working; identified contributors fall back conservatively when absent.
  getUserById?: (id: number) => Promise<Record<string, unknown> | null>
  knownUsersById?: Map<number, UserProfile>
  accountAliases?: Record<number, number>
  warn?: (message: string) => void
}

// Neutral profile URL for an identity that could not be resolved. The website
// needs a valid HTTP profile URL, but the historical login may now belong to a
// different (recycled) account, so link the bare GitHub host instead.
export const NEUTRAL_PROFILE_URL = 'https://github.com/'

// A `github.com/<user>` link is username-derived, so it is unsafe to attach to
// an identity we could not resolve (the login may be recycled).
const isGithubUsernameUrl = (value: unknown): boolean =>
  typeof value === 'string' &&
  /^https?:\/\/(www\.)?github\.com\/[^/]+\/?$/i.test(value)

const authorNumericId = (author: Stat['author']): number | null => {
  const id = (author as { id?: unknown } | null)?.id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

interface Accumulator {
  identity: string
  id: number | null
  login: string
  archivedLogin: string
  total: number
  stat: Pick<Week, 'a' | 'd' | 'c'>
  perRepo: Record<string, number>
  firstCommitTime: number
}

// Resolve an identified contributor by stable numeric ID. The lookup must
// return the same ID to be trusted; a mismatch, 404 or transient failure keeps
// the historical contribution/name/avatar and never links the old login.
const resolveIdProfile = async (
  accumulator: Accumulator,
  options: AggregateOptions,
  knownUsersById: Map<number, UserProfile>,
): Promise<UserProfile> => {
  const id = accumulator.id as number
  const warn = options.warn ?? ((message: string) => console.warn(message))
  if (options.getUserById) {
    try {
      const user = await options.getUserById(id)
      if (
        user &&
        typeof user.id === 'number' &&
        user.id === id &&
        typeof user.avatar_url === 'string' &&
        typeof user.html_url === 'string'
      ) {
        return {
          login:
            typeof user.login === 'string' && user.login.trim() !== ''
              ? user.login
              : accumulator.archivedLogin,
          // Preserve `null` explicitly returned by GitHub rather than dropping
          // the field.
          name:
            typeof user.name === 'string'
              ? user.name
              : user.name === null
                ? null
                : undefined,
          id,
          avatar_url: user.avatar_url,
          html_url: user.html_url,
        }
      }
      warn(
        `⚠️  profile lookup for github id ${id} did not match the expected identity; keeping historical data`,
      )
    } catch (error) {
      // A transient failure is never treated as a deletion; the next build
      // retries the ID lookup.
      warn(
        `⚠️  failed to load profile for github id ${id}, keeping historical data: ${String(
          error,
        )}`,
      )
    }
  }

  // Fallback: a previously published profile for this exact ID supplies the
  // historical login/name. The avatar is always ID-addressed: an archived
  // avatar may belong to an alias source ID or be username-addressed, so it is
  // not safe to attach to this identity. Never a login-keyed profile, which may
  // be recycled.
  const known = knownUsersById.get(id)
  const knownForId = known && known.id === id ? known : undefined
  return {
    login: knownForId?.login ?? accumulator.archivedLogin,
    name: knownForId?.name,
    id,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    html_url: NEUTRAL_PROFILE_URL,
  }
}

const resolveProfile = async (
  login: string,
  options: AggregateOptions,
): Promise<UserProfile> => {
  try {
    const user = await options.getUser(login)
    if (
      user &&
      typeof user.avatar_url === 'string' &&
      typeof user.html_url === 'string'
    ) {
      return {
        login: typeof user.login === 'string' ? user.login : login,
        // Preserve `null` explicitly returned by GitHub rather than dropping
        // the field.
        name:
          typeof user.name === 'string'
            ? user.name
            : user.name === null
              ? null
              : undefined,
        id:
          typeof user.id === 'number'
            ? user.id
            : user.id === null
              ? null
              : undefined,
        avatar_url: user.avatar_url,
        html_url: user.html_url,
      }
    }
  } catch (error) {
    console.warn(`⚠️  failed to load profile for ${login}, falling back:`, error)
  }

  const known = options.knownUsers.get(login)
  if (known) {
    return known
  }

  // Canonical GitHub URL fallback: the avatar endpoint still works even if the
  // profile API endpoint is unavailable, so a contributor is never dropped for
  // want of a profile call.
  return {
    login,
    avatar_url: `https://github.com/${login}.png`,
    html_url: `https://github.com/${login}`,
  }
}

// Bound concurrent profile lookups so a slow profile API cannot dominate the
// job budget now that they run in parallel.
const PROFILE_CONCURRENCY = 4

export const aggregateContributors = async (
  repoStats: RepoStats[],
  options: AggregateOptions,
): Promise<ContributorCollection> => {
  const accountAliases = options.accountAliases ?? {}
  const knownUsersById = options.knownUsersById ?? new Map<number, UserProfile>()
  const warn = options.warn ?? ((message: string) => console.warn(message))

  // Group by stable identity: the numeric account ID when known (so old/new
  // login spellings of the same account merge), otherwise the login. Entries
  // with a null author cannot be attributed and are skipped; bots are excluded
  // before any profile lookup so they can never re-enter through aliases.
  const accumulators = new Map<string, Accumulator>()

  const accumulate = (acc: Accumulator, repoName: string, stat: Stat): void => {
    acc.total += stat.total
    acc.stat = reduceStat(stat.weeks, acc.stat)
    acc.perRepo[repoName] = stat.total
    acc.firstCommitTime = Math.min(
      acc.firstCommitTime,
      getFirstCommitTime(stat.weeks),
    )
  }

  for (const { repoName, stats } of repoStats) {
    if (!Array.isArray(stats)) {
      continue
    }
    for (const stat of stats) {
      const { author } = stat
      if (!author || isExcludedContributor(author)) {
        continue
      }

      const id = authorNumericId(author)
      let acc: Accumulator | undefined
      if (id !== null) {
        // A curated cross-account alias merges the source ID into the explicit
        // target ID; otherwise the stable ID stands alone.
        const effectiveId = accountAliases[id] ?? id
        const identity = `id:${effectiveId}`
        acc = accumulators.get(identity)
        if (!acc) {
          acc = {
            identity,
            id: effectiveId,
            login: author.login,
            archivedLogin: author.login,
            total: 0,
            stat: { a: 0, d: 0, c: 0 },
            perRepo: {},
            firstCommitTime: Infinity,
          }
          accumulators.set(identity, acc)
        }
      } else {
        const login = options.aliases[author.login] || author.login
        if (isExcludedLogin(login)) {
          continue
        }
        const identity = `login:${login.toLowerCase()}`
        acc = accumulators.get(identity)
        if (!acc) {
          acc = {
            identity,
            id: null,
            login,
            archivedLogin: login,
            total: 0,
            stat: { a: 0, d: 0, c: 0 },
            perRepo: {},
            firstCommitTime: Infinity,
          }
          accumulators.set(identity, acc)
        }
      }
      accumulate(acc, repoName, stat)
    }
  }

  const profiles = new Map<string, UserProfile>()
  await bluebird.map(
    [...accumulators.values()],
    async accumulator => {
      const profile =
        accumulator.id !== null
          ? await resolveIdProfile(accumulator, options, knownUsersById)
          : await resolveProfile(accumulator.login, options)
      profiles.set(accumulator.identity, profile)
    },
    { concurrency: PROFILE_CONCURRENCY },
  )

  const contributors: ContributorCollection = {}
  const loginOwner = new Map<string, number | null>()
  for (const accumulator of accumulators.values()) {
    const profile = profiles.get(accumulator.identity)!
    const login = profile.login
    const loginKey = login.toLowerCase()
    const owner = loginOwner.get(loginKey)
    let key = login
    if (owner !== undefined && owner !== accumulator.id) {
      // Two different identities claim the same login (e.g. a recycled
      // username across repos). Never merge or overwrite them silently.
      warn(
        `⚠️  login ${login} is claimed by different identities (${String(
          owner,
        )} and ${String(accumulator.id)}); keeping them separate`,
      )
      key = accumulator.identity
    } else {
      loginOwner.set(loginKey, accumulator.id)
    }
    contributors[key] = {
      avatar_url: profile.avatar_url,
      firstCommitTime: accumulator.firstCommitTime,
      html_url: profile.html_url,
      id: profile.id ?? accumulator.id,
      login,
      name: profile.name,
      perRepo: accumulator.perRepo,
      stat: accumulator.stat,
      total: accumulator.total,
    }
  }

  return contributors
}

export interface BuildDeps {
  getRepos: () => Promise<Repo[]>
  listCachedRepos: () => Promise<string[]>
  loadRepoManifest: () => Promise<string[]>
  saveRepoManifest: (repos: string[]) => Promise<unknown>
  loadCachedData: (repoFullName: string) => Promise<Stat[] | null>
  getContributors: (
    owner: string,
    repo: string,
    previous: Stat[] | null,
  ) => Promise<Stat[]>
  getUser: (login: string) => Promise<Record<string, unknown> | null>
  getUserById: (id: number) => Promise<Record<string, unknown> | null>
  loadPreviousContributors: () => Promise<ContributorSimple[]>
  refreshAvatars: (
    contributors: ContributorSimple[],
  ) => Promise<{ images: Map<string, Buffer>; skipped: boolean }>
  buildSvg: (
    contributors: ContributorSimple[],
    images: Map<string, Buffer>,
    avatarsSkipped: boolean,
  ) => Promise<string>
  writeDist: (json: string, svg: string) => Promise<void>
  log: (message: string) => void
  warn: (message: string) => void
}

export interface BuildResult {
  repos: string[]
  contributorCount: number
}

export const runBuild = async (deps: BuildDeps): Promise<BuildResult> => {
  let discovered: Repo[] = []
  let discoveryFailed = false
  try {
    discovered = await deps.getRepos()
  } catch (error) {
    discoveryFailed = true
    deps.warn(`⚠️  repo discovery failed, using archived repo list: ${String(error)}`)
  }

  const [archived, manifest] = await Promise.all([
    deps.listCachedRepos(),
    deps.loadRepoManifest(),
  ])

  const repoFullNames = resolveRepoList({
    discovered,
    archived,
    manifest,
    extra: MORE_REPO,
    ignored: IGNORED_REPO,
  })

  if (!discoveryFailed) {
    await deps.saveRepoManifest(repoFullNames)
  }

  deps.log(`⚡️ collecting stats for ${repoFullNames.length} repos`)

  const settled = await bluebird.map(
    repoFullNames,
    async (repoFullName): Promise<RepoStats | null> => {
      const split = splitRepo(repoFullName)
      if (!split) {
        deps.warn(`⚠️  skipping malformed repo name: ${repoFullName}`)
        return null
      }
      const [owner, repo] = split
      const previous = await deps.loadCachedData(repoFullName)
      const stats = await deps.getContributors(owner, repo, previous)
      return { repoName: repoFullName, stats }
    },
    { concurrency: MAX_CONCURRENCY },
  )
  const repoStats: RepoStats[] = settled.filter(
    (entry): entry is RepoStats => entry !== null,
  )

  const previousOutput = await deps.loadPreviousContributors()
  const previousUsers = toKnownUsers(previousOutput)
  const previousUsersById = toKnownUsersById(previousOutput)
  const collection = await aggregateContributors(repoStats, {
    getUser: deps.getUser,
    knownUsers: previousUsers,
    aliases: ALIAS,
    getUserById: deps.getUserById,
    knownUsersById: previousUsersById,
    accountAliases: ACCOUNT_ALIAS,
    warn: deps.warn,
  })

  // If we could not attribute a single contributor but we already have a full
  // published output, refuse to replace it with just the manual entries.
  if (Object.keys(collection).length === 0 && previousOutput.length > 0) {
    throw new Error(
      'no attributable contributors were collected; refusing to overwrite the previous output',
    )
  }

  // Apply overrides only to contributors that actually exist, so an override
  // entry can never invent a phantom contributor. Identified contributors are
  // matched by stable numeric ID (following a legitimate rename, never a
  // recycled login); only no-ID legacy rows fall back to the login-keyed map.
  // An unresolved identity keeps its neutral profile link: a github.com/<user>
  // override would otherwise re-introduce a username link that may now point at
  // a recycled account.
  const overwritten = _.mapValues(collection, contributor => {
    const id =
      typeof contributor.id === 'number' && Number.isFinite(contributor.id)
        ? contributor.id
        : null
    const overwrite =
      id !== null ? OVERWRITES_BY_ID[id] : OVERWRITES[contributor.login]
    if (!overwrite) {
      return contributor
    }
    const safeOverwrite =
      contributor.html_url === NEUTRAL_PROFILE_URL &&
      isGithubUsernameUrl(overwrite.html_url)
        ? { ...overwrite, html_url: undefined }
        : overwrite
    return _.merge({}, contributor, safeOverwrite)
  })

  const data: ContributorSimple[] = [
    ...MORE_PEOPLE,
    ..._.sortBy(overwritten, contributor => contributor.firstCommitTime),
  ].filter(contributor => !isExcludedLogin(contributor.login))

  // Refresh public donors and avatar sprites (this already publishes
  // dist/avatars), then generate the complete JSON and SVG before writing the
  // legacy contributors output, so a failed SVG render keeps the last-good
  // contributors.json/graph.svg.
  const avatars = await deps.refreshAvatars(data)
  const json = `${JSON.stringify(data, null, 2)}\n`
  const svg = await deps.buildSvg(data, avatars.images, avatars.skipped)
  await deps.writeDist(json, svg)

  return { repos: repoFullNames, contributorCount: data.length }
}

const writeIfChanged = async (
  filePath: string,
  content: string,
): Promise<boolean> => {
  if (await fs.pathExists(filePath)) {
    const existing = await fs.readFile(filePath, 'utf8')
    if (existing === content) {
      return false
    }
  }
  const tempPath = `${filePath}.tmp`
  await fs.outputFile(tempPath, content)
  await fs.move(tempPath, filePath, { overwrite: true })
  return true
}

const loadPreviousContributors = async (
  distDir: string,
): Promise<ContributorSimple[]> => {
  const filePath = join(distDir, 'contributors.json')
  if (!(await fs.pathExists(filePath))) {
    return []
  }
  try {
    const parsed = await fs.readJson(filePath)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    console.warn('Failed to read previous contributors output:', error)
    return []
  }
}

export const writeDist = async (
  distDir: string,
  json: string,
  svg: string,
): Promise<void> => {
  await fs.ensureDir(distDir)
  const jsonChanged = await writeIfChanged(join(distDir, 'contributors.json'), json)
  const svgChanged = await writeIfChanged(join(distDir, 'graph.svg'), svg)
  if (!jsonChanged && !svgChanged) {
    console.info('no changes in dist output')
  }
}

// Real graph.svg generation for a dist directory: reuse archived contributor
// images, never re-fetching one the avatar refresh already handled. Kept as a
// named function so integration tests drive the production path rather than
// recreating it.
export const buildDistSvg = async (
  contributors: ContributorSimple[],
  images: Map<string, Buffer>,
  avatarsSkipped: boolean,
  distDir: string,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const svgPath = join(distDir, 'graph.svg')
  const existingSvg = (await fs.pathExists(svgPath))
    ? await fs.readFile(svgPath, 'utf8')
    : undefined
  const placeholder = avatarsSkipped ? undefined : await renderPlaceholderBase64()
  return buildSvg(contributors, {
    existingSvg,
    getImage: async (url, fallback) => {
      const archived = images.get(url)
      if (archived) {
        return renderCircleBase64(archived)
      }
      // A refresh already tried this contributor's image. Do not hit the
      // network again; use the embedded last-good avatar, or a neutral
      // placeholder for a first-time image.
      if (!avatarsSkipped) {
        return fallback ?? placeholder!
      }
      // Refresh was skipped (OpenCollective unavailable): keep the legacy path
      // so graph.svg still renders with a real fetch attempt. An injected fetch
      // is reused here so no unexpected network is touched.
      return getImage(url, fallback, fetchImpl)
    },
  })
}

export interface BuildOptions {
  distDir: string
  repoCacheDir: string
  avatarCacheDir: string
  avatarDistDir: string
  supportersArchivePath: string
  fetchImpl?: typeof fetch
}

export const defaultBuildOptions = (): BuildOptions => ({
  distDir,
  repoCacheDir: CACHE_DIR,
  avatarCacheDir: DEFAULT_CACHE_DIR,
  avatarDistDir: DEFAULT_DIST_DIR,
  supportersArchivePath: SUPPORTERS_ARCHIVE_PATH,
})

// Assemble the production pipeline. Only external inputs (GitHub calls, the
// public OC/image fetch) and filesystem locations are injectable; the real
// avatar/sprite/SVG/write logic is always used.
export const createBuildDeps = (
  options: BuildOptions = defaultBuildOptions(),
  overrides: Partial<BuildDeps> = {},
): BuildDeps => ({
  getRepos: () => getRepos(),
  listCachedRepos: () => listCachedRepos(options.repoCacheDir),
  loadRepoManifest: () => loadRepoManifest(options.repoCacheDir),
  saveRepoManifest: repos => saveRepoManifest(repos, options.repoCacheDir),
  loadCachedData: repoFullName =>
    loadCachedData(repoFullName, options.repoCacheDir),
  getContributors: (owner, repo, previous) =>
    fetchContributors(owner, repo, {
      previous,
      save: (repoFullName, data) =>
        saveCachedData(repoFullName, data, options.repoCacheDir),
    }),
  getUser: login => getUser(login),
  getUserById: id => getUserById(id),
  loadPreviousContributors: () => loadPreviousContributors(options.distDir),
  refreshAvatars: async contributors => {
    const result = await refreshAvatars({
      contributors,
      fetchImpl: options.fetchImpl,
      cacheDir: options.avatarCacheDir,
      distDir: options.avatarDistDir,
      archivePath: options.supportersArchivePath,
    })
    return { images: result.contributorImages, skipped: result.skipped }
  },
  buildSvg: (contributors, images, avatarsSkipped) =>
    buildDistSvg(
      contributors,
      images,
      avatarsSkipped,
      options.distDir,
      options.fetchImpl,
    ),
  writeDist: (json, svg) => writeDist(options.distDir, json, svg),
  log: message => console.info(chalk.cyan(message)),
  warn: message => console.warn(chalk.yellow(message)),
  ...overrides,
})

const main = async (): Promise<void> => {
  try {
    await runBuild(createBuildDeps())
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

if (require.main === module) {
  void main()
}
