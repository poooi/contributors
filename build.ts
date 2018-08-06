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
  console.info('⚡️', ORG_REPOS)

  const contributorPerRepo: Array<Array<string | IStat[]>> = _.compact(
    await Promise.map(
      repos.map(r => r.full_name).concat(MORE_REPO),
      async (name: string) => {
        const url = `https://api.github.com/repos/${name}/stats/contributors`
        const people: IStat[] = await get(url)
        console.info('⚡️', url)
        if (!people) {
          console.warn(chalk.yellow('[WARN]', url))
          return
        }
        return [name, people]
      },
    ),
  )

  const contributors: IContributorCollection = {}

  await Promise.each(contributorPerRepo, async ([repoName, people]) =>
    Promise.each(
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
    ),
  )

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
    //  auto commit the changes or notify error in CI
    if (process.env.CI) {
      const {
        TRAVIS_EVENT_TYPE,
        TRAVIS_REPO_SLUG,
        TRAVIS_BRANCH,
        TRAVIS_PULL_REQUEST_BRANCH,
      } = process.env
      console.info(
        TRAVIS_EVENT_TYPE,
        TRAVIS_REPO_SLUG,
        TRAVIS_BRANCH,
        TRAVIS_PULL_REQUEST_BRANCH,
      )
      if (TRAVIS_EVENT_TYPE !== 'cron') {
        // we only auto commit when doing cron job
        throw new Error('Not in cron mode')
      }

      await execAsync(
        `git remote add target git@github.com:${TRAVIS_REPO_SLUG}.git`,
      )
      await execAsync(`git commit -a -m "chore: auto update ${Date.now()}"`)

      const { stdout: remoteInfo } = await execAsync('git remote show target')
      console.info(remoteInfo)
      await execAsync(
        `git push target HEAD:${TRAVIS_PULL_REQUEST_BRANCH || TRAVIS_BRANCH}`,
      )
    }
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
