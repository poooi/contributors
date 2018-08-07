import Promise from 'bluebird'
import chalk from 'chalk'
import childProcess from 'child_process'
import fs from 'fs-extra'
import _ from 'lodash'
import { join } from 'path'
import util from 'util'

import {
  ALIAS,
  IGNORES,
  MORE_PEOPLE,
  MORE_REPO,
  ORG_REPOS,
  OVERWRITES,
} from './config'
import {
  IContributorCollection,
  IContributorSimple,
  IRepo,
  IStat,
} from './types'
import { buildSvg, get, getFirstCommitTime, reduceStat } from './utils'

const execAsync = util.promisify(childProcess.exec)

const build = async () => {
  const repos: IRepo[] = await get(ORG_REPOS)
  console.info(chalk.cyan('start to fetch all repo url...'))
  console.info('⚡️', ORG_REPOS)

  const contributorPerRepo: Array<Array<string | IStat[]>> = _.compact(
    await Promise.map(
      repos.map(r => r.full_name).concat(MORE_REPO),
      async (name: string) => {
        const url = `https://api.github.com/repos/${name}/stats/contributors`
        const people: IStat[] = await get(url)
        console.info('⚡️', url)
        if (!people || (people && people.length === 0)) {
          console.warn('[WARN] `people` is null or empty array, ', url, people)
        }
        return [name, people]
      },
    ),
  )

  const contributors: IContributorCollection = {}

  console.info(chalk.cyan("start to init contributors' info..."))
  console.info(contributorPerRepo) // FIXME: log for currently debug, remove it when bug resolved

  await Promise.each(contributorPerRepo, async ([repoName, people]) => {
    if (!repoName || !people) {
      console.warn(chalk.yellow('[WARN] `repoName` or `people` is null'))
      console.warn(chalk.yellow('repoName: '), repoName)
      return
    }
    return Promise.each(
      people as IStat[],
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
          contributors[login].total! += total
          contributors[login].stat = reduceStat(weeks, contributors[login].stat)
          contributors[login].perRepo![repoName as string] = total
          contributors[login].firstCommitTime = Math.min(
            contributors[login].firstCommitTime!,
            getFirstCommitTime(weeks),
          )
        }
      },
    )
  })

  const data: IContributorSimple[] = [
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

const main = async () => {
  try {
    await build()
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
}

main()
