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
  ORG_REPOS,
  OVERWRITES,
} from './config'
import {
  ContributorCollection,
  ContributorSimple,
  Repo,
  Stat,
} from './types'
import { buildSvg, get, getContributors, getFirstCommitTime, reduceStat } from './utils'

const execAsync = util.promisify(childProcess.exec)

const build = async (): Promise<void> => {
  const repos: Repo[] = await get(ORG_REPOS)
  console.info(chalk.cyan('start to fetch all repo url...'))
  console.info('⚡️', ORG_REPOS)

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
    if (!repoName || !people) {
      console.warn(chalk.yellow('[WARN] `repoName` or `people` is null'))
      console.warn(chalk.yellow('repoName: '), repoName)
      return Promise.resolve()
    }
    return bluebird.each(
      people as Stat[],
      async ({
        total,
        weeks,
        author: {
          login: originalLogin,
          id,
          avatar_url: avatarUrl,
          html_url: htmlUrl,
        },
      }) => {
        const login = ALIAS[originalLogin] || originalLogin
        if (!contributors[login]) {
          console.info(login)
          const user = await get(`https://api.github.com/users/${login}`)
          contributors[login] = {
            avatar_url: avatarUrl,
            firstCommitTime: getFirstCommitTime(weeks),
            html_url: htmlUrl,
            id,
            login,
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
