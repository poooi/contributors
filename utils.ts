import { Octokit } from '@octokit/rest'
import bluebird from 'bluebird'
import chalk from 'chalk'
import childProcess from 'child_process'
import _ from 'lodash'
import fetch, { RequestInit } from 'node-fetch'
import pRetry from 'p-retry'
import sharp from 'sharp'
import { promisify } from 'util'
import { ContributorSimple, Stat, Week } from './types'
import { loadCachedData, saveCachedData } from './cache'

const execFile = promisify(childProcess.execFile)

// Resolve the token from the user's locally logged-in `gh` CLI
const getGhToken = async (): Promise<string> => {
  const { stdout } = await execFile('gh', ['auth', 'token'])
  return stdout.trim()
}

const octokitPromise: Promise<Octokit> = getGhToken().then(
  token => new Octokit({ auth: token }),
)

const fetchOptions: RequestInit = {
  headers: {
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  }
}

const AVATAR_SIZE = 64
const MARGIN = 10
const COLS = 12
const IMAGE_WIDTH = AVATAR_SIZE * COLS + MARGIN * (COLS + 1)
const ROUND = Buffer.from(
  `<svg><rect x="0" y="0" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" rx="${AVATAR_SIZE /
    2}" ry="${AVATAR_SIZE / 2}"/></svg>`,
)

export const getRepos = async (): Promise<any[]> => {
  const octokit = await octokitPromise
  return octokit.paginate(octokit.rest.repos.listForOrg, {
    org: 'poooi',
    per_page: 100,
  })
}

export const getUser = async (login: string): Promise<any> => {
  const octokit = await octokitPromise
  return octokit.rest.users.getByUsername({ username: login }).then(res => res.data)
}

export const getContributors = async (owner: string, repo: string): Promise<Stat[]> => {
  const repoFullName = `${owner}/${repo}`

  // Try to load from cache first
  const cachedData = await loadCachedData(repoFullName)
  if (cachedData) {
    console.info(chalk.gray(`💾 Using cached data for ${repoFullName}`))
    return cachedData
  }

  // Fetch from API if not cached
  console.info(chalk.cyan(`🌐 Fetching ${repoFullName}...`))

  const data = await pRetry(
    async () => {
      try {
        const octokit = await octokitPromise
        const res = await octokit.rest.repos.getContributorsStats({ owner, repo })
        // GitHub returns HTTP 202 with an empty body {} while stats are still being
        // computed. octokit does not throw for 202, so detect it here and retry.
        if (res.status === 202 || !Array.isArray(res.data)) {
          console.info(chalk.yellow(`⏳ Computing stats for ${repoFullName}...`))
          throw new Error('Stats being computed (202 - will retry)')
        }
        return res.data as Stat[]
      } catch (e) {
        // octokit may also surface the 202 as a thrown error in some paths
        if ((e as any)?.status === 202) {
          console.info(chalk.yellow(`⏳ Computing stats for ${repoFullName}...`))
          throw new Error('Stats being computed (202 - will retry)')
        }
        console.error(chalk.red(`[ERROR] ${repoFullName}:`), e)
        throw e
      }
    },
    {
      retries: 30,
      minTimeout: 5000,
      maxTimeout: 30000,
      factor: 1.5,
      onFailedAttempt: (error) => {
        console.info(
          chalk.gray(`Retry ${error.attemptNumber}/${error.retriesLeft + error.attemptNumber} for ${repoFullName}`)
        )
      }
    }
  )

  // Save to cache
  if (data && data.length > 0) {
    const nullAuthors = data.filter(s => !s.author)
    if (nullAuthors.length > 0) {
      console.warn(
        chalk.yellow(
          `⚠️  ${repoFullName}: ${nullAuthors.length}/${data.length} contributors have null author (skipping in build)`,
        ),
      )
    }
    await saveCachedData(repoFullName, data)
    console.info(chalk.green(`✅ Fetched ${data.length} contributors for ${repoFullName}`))
  } else {
    console.warn(chalk.yellow(`⚠️  Empty data for ${repoFullName}`))
  }

  // Normalize: GitHub may return an empty object {} (or null) for repos without
  // attributable contributor data; always return an array.
  return Array.isArray(data) ? data : []
}

const getImage = (url: string): Promise<string> =>
  pRetry(
    async () => {
      try {
        const resp = await fetch(url, fetchOptions)
        const buf = await resp.arrayBuffer()
        const img = await sharp(Buffer.from(buf))
          .resize(AVATAR_SIZE)
          .composite([{ input: ROUND, blend: 'dest-in' }])
          .png()
          .toBuffer()
        console.info('🎆', url)
        return img.toString('base64')
      } catch (e) {
        console.error(url, e)
        return bluebird.reject(e)
      }
    },
    { retries: 5 },
  )

export const reduceStat = (weeks: Week[], initStat = { a: 0, d: 0, c: 0 }): Pick<Week, 'a' | 'd' | 'c'> =>
  _.reduce(
    weeks,
    ({ a: newA, d: newD, c: newC }, { a, d, c }) => ({
      a: a + newA,
      c: c + newC,
      d: d + newD,
    }),
    initStat,
  )

export const getFirstCommitTime = (weeks: Week[]): number => {
  const first = _.find(weeks, week => week.c > 0)
  return first ? first.w : Infinity
}

export const buildSvg = async (contributors: ContributorSimple[]): Promise<string> => {
  const data = await bluebird.map(contributors, ({ avatar_url: avatarUrl }) =>
    getImage(avatarUrl),
  )
  let posX = MARGIN
  let posY = MARGIN
  const imgs: string[] = []
  _.each(contributors, (p, index) => {
    if (posX + MARGIN + AVATAR_SIZE > IMAGE_WIDTH) {
      posY += AVATAR_SIZE + MARGIN
      posX = MARGIN
    }
    const image = `<image x="${posX}" y="${posY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" xlink:href="data:png;base64,${data[index]}"/>`
    imgs.push(`<a xlink:href="${p.html_url}" target="_blank" id="${p.login}">
      ${image}
      <rect x="${posX - 2}" y="${posY - 2}" width="${AVATAR_SIZE +
      4}" height="${AVATAR_SIZE +
      4}" stroke="#B3E5FC" stroke-width="2" fill="none" rx="${AVATAR_SIZE / 2 +
      2}" ry="${AVATAR_SIZE / 2 + 2}" />
    </a>`)
    posX += AVATAR_SIZE + MARGIN
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${IMAGE_WIDTH}" height="${posY +
    AVATAR_SIZE +
    MARGIN}">
${imgs.join('\n')}
</svg>`
}
