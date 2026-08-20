import bluebird from 'bluebird'
import chalk from 'chalk'
import childProcess from 'child_process'
import fs from 'fs-extra'
import _ from 'lodash'
import { join } from 'path'
import util from 'util'

import {
  ALIAS,
  IGNORED_REPO,
  IGNORES,
  MORE_PEOPLE,
  MORE_REPO,
  OVERWRITES,
} from './config'
import {
  ContributorCollection,
  ContributorSimple,
  Repo,
  Stat,
} from './types'
import { buildSvg, getContributors, getFirstCommitTime, getRepos, getUser, reduceStat } from './utils'

const execAsync = util.promisify(childProcess.exec)

const build = async (): Promise<void> => {
  const repos: Repo[] = await getRepos()
  console.info(chalk.cyan('start to fetch all repo url...'))
  console.info('⚡️', 'poooi org repos')

  const contributorPerRepo: Array<Array<string | Stat[]>> = _.compact(
    await bluebird.map(
      repos
        .map(r => r.full_name)
        .concat(MORE_REPO)
        .filter(repo => !IGNORED_REPO.includes(repo)),
      async (name: string) => {
        const [owner, repo] = name.split('/')
        const people: Stat[] = await getContributors(owner, repo)
        console.info('⚡️', `https://api.github.com/repos/${owner}/${repo}/stats/contributors`)
        if (!people || (people && people.length === 0)) {
          console.warn('[WARN] `people` is null or empty array, ', `https://api.github.com/repos/${owner}/${repo}/stats/contributors`, people)
        }
        return [name, people]
      },
    ),
  )

  const contributors: ContributorCollection = {}

  console.info(chalk.cyan("start to init contributors' info..."))
  console.info(contributorPerRepo) // FIXME: log for currently debug, remove it when bug resolved

  await bluebird.each(contributorPerRepo, async ([repoName, people]) => {
    if (!repoName || !people || !Array.isArray(people)) {
      console.warn(chalk.yellow(`[WARN] repoName=${repoName}, people=${JSON.stringify(people)}`))
      return Promise.resolve()
    }
    console.info(chalk.cyan(`➡️  processing ${repoName} (${people.length} contributors)`))
    return bluebird.each(
      people as Stat[],
      async ({ total, weeks, author }) => {
        // Entries with a null author cannot be attributed to a user (e.g. commits
        // from deleted accounts); skip them.
        if (!author) {
          console.warn(
            chalk.yellow(
              `[WARN] null author in ${repoName} (total=${total}, weeks=${weeks ? weeks.length : 0}), skipping`,
            ),
          )
          return Promise.resolve()
        }
        const { login: originalLogin } = author
        const login = ALIAS[originalLogin] || originalLogin
        if (!contributors[login]) {
          console.info(`👤 ${login} (repo: ${repoName})`)
          const user = await getUser(login)
          if (!user) {
            console.warn(chalk.yellow(`[WARN] getUser(${login}) returned null, skipping`))
            return Promise.resolve()
          }
          contributors[login] = {
            avatar_url: user.avatar_url,
            firstCommitTime: getFirstCommitTime(weeks),
            html_url: user.html_url,
            id: user.id,
            login: user.login,
            name: user.name,
            perRepo: {
              [repoName as string]: total,
            },
            stat: reduceStat(weeks),
            total,
          }
        } else {
          contributors[login].total += total
          contributors[login].stat = reduceStat(weeks, contributors[login].stat)
          contributors[login].perRepo[repoName as string] = total
          contributors[login].firstCommitTime = Math.min(
            contributors[login].firstCommitTime,
            getFirstCommitTime(weeks),
          )
        }
      },
    )
  })

  const data: ContributorSimple[] = [
    ...MORE_PEOPLE,
    ..._.sortBy(_.merge(contributors, OVERWRITES), p => p.firstCommitTime),
  ].filter(p => !IGNORES.includes(p.login))

  await fs.outputJson(join(__dirname, 'dist', 'contributors.json'), data, {
    spaces: 2,
  })

  const img = await buildSvg(data)
  await fs.outputFile(join(__dirname, 'dist', 'graph.svg'), img)

  const { stdout: gitStatus } = await execAsync('git status -s')
  console.info(gitStatus)
  if (gitStatus) {
    console.info(chalk.red('some files updated, please check and commit them'))
  }
}

const main = async (): Promise<void> => {
  try {
    await build()
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
}

main()
