import bluebird from 'bluebird'
import chalk from 'chalk'
import fs from 'fs-extra'
import _ from 'lodash'
import { join } from 'path'

import {
  ALIAS,
  IGNORED_REPO,
  isExcludedContributor,
  isExcludedLogin,
  MORE_PEOPLE,
  MORE_REPO,
  OVERWRITES,
} from './config'
import { getContributors as fetchContributors, getRepos, getUser } from './github'
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

export interface RepoStats {
  repoName: string
  stats: Stat[]
}

export interface AggregateOptions {
  getUser: (login: string) => Promise<Record<string, unknown> | null>
  knownUsers: Map<string, UserProfile>
  aliases: Record<string, string>
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
  const contributors: ContributorCollection = {}

  // Resolve the unique set of logins up front so profile lookups can run with
  // bounded concurrency instead of sequentially.
  const logins = new Set<string>()
  for (const { stats } of repoStats) {
    if (!Array.isArray(stats)) {
      continue
    }
    for (const stat of stats) {
      if (!stat.author) {
        continue
      }
      if (isExcludedContributor(stat.author)) {
        continue
      }
      const originalLogin = stat.author.login
      const login = options.aliases[originalLogin] || originalLogin
      if (isExcludedLogin(login)) {
        continue
      }
      logins.add(login)
    }
  }

  const profiles = new Map<string, UserProfile>()
  await bluebird.map(
    [...logins],
    async login => {
      profiles.set(login, await resolveProfile(login, options))
    },
    { concurrency: PROFILE_CONCURRENCY },
  )

  for (const { repoName, stats } of repoStats) {
    if (!Array.isArray(stats)) {
      continue
    }
    for (const stat of stats) {
      const { total, weeks, author } = stat
      // Entries with a null author cannot be attributed to a user (e.g.
      // commits from deleted accounts); skip them. Historical attributable
      // data is never removed by this. Bots are excluded before any profile
      // lookup so they can never re-enter through aliases or known users.
      if (!author) {
        continue
      }
      if (isExcludedContributor(author)) {
        continue
      }

      const originalLogin = author.login
      const login = options.aliases[originalLogin] || originalLogin
      if (isExcludedLogin(login)) {
        continue
      }
      const existing = contributors[login]

      if (!existing) {
        const profile = profiles.get(login)!
        contributors[login] = {
          avatar_url: profile.avatar_url,
          firstCommitTime: getFirstCommitTime(weeks),
          html_url: profile.html_url,
          id: profile.id,
          login: profile.login,
          name: profile.name,
          perRepo: { [repoName]: total },
          stat: reduceStat(weeks),
          total,
        }
      } else {
        existing.total += total
        existing.stat = reduceStat(weeks, existing.stat)
        existing.perRepo[repoName] = total
        existing.firstCommitTime = Math.min(
          existing.firstCommitTime,
          getFirstCommitTime(weeks),
        )
      }
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
  const collection = await aggregateContributors(repoStats, {
    getUser: deps.getUser,
    knownUsers: previousUsers,
    aliases: ALIAS,
  })

  // If we could not attribute a single contributor but we already have a full
  // published output, refuse to replace it with just the manual entries.
  if (Object.keys(collection).length === 0 && previousOutput.length > 0) {
    throw new Error(
      'no attributable contributors were collected; refusing to overwrite the previous output',
    )
  }

  // Apply overrides only to contributors that actually exist, so an override
  // entry can never invent a phantom contributor.
  const overwritten = _.mapValues(collection, (contributor, login) => {
    const overwrite = OVERWRITES[login]
    return overwrite ? _.merge({}, contributor, overwrite) : contributor
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
