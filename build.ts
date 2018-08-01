import Promise from 'bluebird'
import chalk from 'chalk'
import childProcess from 'child_process'
import fs from 'fs-extra'
import HttpsProxyAgent from 'https-proxy-agent'
import _ from 'lodash'
import fetch, { RequestInit } from 'node-fetch'
import pRetry from 'p-retry'
import { join } from 'path'
import sharp from 'sharp'
import SocksProxyAgent from 'socks-proxy-agent'
import util from 'util'

interface IRepo {
  full_name: string
}

interface IPeople {
  login: string
  id: number
  node_id: string
  avatar_url: string
  gravatar_id: string
  url: string
  html_url: string
  followers_url: string
  following_url: string
  gists_url: string
  starred_url: string
  subscriptions_url: string
  organizations_url: string
  repos_url: string
  events_url: string
  received_events_url: string
  type: string
  site_admin: false
  contributions: number
}

interface IWeek {
  w: number
  a: number
  d: number
  c: number
}

interface IStat {
  total: number
  weeks: IWeek[]
  author: IPeople
}

interface IContributor {
  login: string
  name: string
  id: number
  avatar_url: string
  html_url: string
  total: number
  stat: Pick<IWeek, 'a' | 'd' | 'c'>
  firstCommitTime: number
  perRepo: {
    [key: string]: number
  }
}

interface IContributorCollection {
  [key: string]: IContributor
}

type IContributorSimple = Pick<
  IContributor,
  'html_url' | 'avatar_url' | 'login'
>

interface IContributorOverwrite {
  [key: string]: Partial<
    Pick<IContributor, 'html_url' | 'avatar_url' | 'login' | 'name'>
  >
}

interface IAlias {
  [key: string]: string
}

const execAsync = util.promisify(childProcess.exec)

const proxy = process.env.https_proxy || process.env.http_proxy || ''
const ORG_REPOS = 'https://api.github.com/orgs/poooi/repos?per_page=100'

const MORE_REPO = [
  'magicae/poi-nwjs',
  'ruiii/plugin-Hairstrength',
  'dkwingsmt/plugin-wheres-my-fuel-gone',
  'ruiii/poi_theme_paper_dark',
  'Artoria-0x04/poi-theme-lumendark',
  'govizlora/theme-papercyan',
  'Artoria-0x04/paperblack',
  'kcwikizh/poi-plugin-subtitle',
  'kcwikizh/poi-statistics',
  'Javran/poi-plugin-mo2',
]

const MORE_PEOPLE: IContributorSimple[] = [
  {
    avatar_url: 'http://7xkd7e.com1.z0.glb.clouddn.com/season.jpg',
    html_url: 'http://www.pixiv.net/member.php?id=3991162',
    login: 'Season千',
  },
  {
    avatar_url: 'https://avatars1.githubusercontent.com/u/11089376?v=4',
    html_url: 'https://github.com/edwardaaaa',
    login: 'edwardaaaa',
  },
]

const ALIAS: IAlias = {
  dazzyd: 'yukixz',
}

const IGNORES = ['codacy-badger']

const OVERWRITES: IContributorOverwrite = {
  'Artoria-0x04': {
    html_url: 'http://www.weibo.com/pheliox',
  },
  Chibaheit: {
    html_url: 'http://weibo.com/chibaheit',
  },
  Javran: {
    avatar_url:
      'https://gist.githubusercontent.com/Javran/02ac7ebefc307829d02e5dc942f8ef28/raw/250x250.png',
  },
  JenningsWu: {
    html_url: 'http://www.weibo.com/jenningswu',
    name: '吴钩霜雪明',
  },
  KochiyaOcean: {
    html_url: 'http://www.kochiyaocean.org',
  },
  magicae: {
    html_url: 'http://weibo.com/maginya',
  },
  malichan: {
    html_url: 'http://www.weibo.com/1791427467',
    name: '马里酱',
  },
  myzWILLmake: {
    html_url: 'http://weibo.com/myzwillmake',
  },
  yukixz: {
    html_url: 'http://dazzyd.org/',
  },
  zyc434343: {
    html_url: 'http://weibo.com/zyc43',
    name: 'ZYC',
  },
}

const AUTH: string = process.env.AUTH || ''

const fetchOptions: RequestInit = {}

if (proxy) {
  const agent = proxy.match(/^socks/i)
    ? new SocksProxyAgent(proxy)
    : new HttpsProxyAgent(proxy)
  fetchOptions.agent = agent
}

// fetchOptions.agent = proxy ? new HttpsProxyAgent(proxy) : null
if (AUTH) {
  fetchOptions.headers = {
    Authorization: `Basic ${Buffer.from(AUTH).toString('base64')}`,
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

const get = (url: string) =>
  pRetry(
    async () => {
      try {
        const resp = await fetch(url, fetchOptions)
        if (!resp.ok) {
          const parsed = await resp.json()
          console.error(chalk.red(`[ERROR] url: ${url}`), parsed)
          throw new Error(chalk.red('invalid response'))
        }
        const data = await resp.json()
        if (!data) {
          throw new Error(chalk.red('falsy response'))
        }
        return data
      } catch (e) {
        console.info(e)
        return Promise.reject(e)
      }
    },
    { retries: 5 },
  )

const getImage = (url: string) =>
  pRetry(
    async () => {
      try {
        const resp = await fetch(url, fetchOptions)
        const buf = await resp.buffer()
        const img = await sharp(buf)
          .resize(AVATAR_SIZE)
          .overlayWith(ROUND, { cutout: true })
          .png()
          .toBuffer()
        console.info('🎆', url)
        return img.toString('base64')
      } catch (e) {
        console.error(`${url}&size=${AVATAR_SIZE}`, e)
        return Promise.reject(e)
      }
    },
    { retries: 5 },
  )

const reduceStat = (weeks: IWeek[], initStat = { a: 0, d: 0, c: 0 }) =>
  _.reduce(
    weeks,
    ({ a: newA, d: newD, c: newC }, { a, d, c }) => ({
      a: a + newA,
      c: c + newC,
      d: d + newD,
    }),
    initStat,
  )

const getFirstCommitTime = (weeks: IWeek[]) => {
  const first = _.find(weeks, week => week.c > 0)
  return first ? first.w : Infinity
}

const buildSvg = async (contributors: IContributorSimple[]) => {
  const data = await Promise.map(contributors, ({ avatar_url: avatarUrl }) =>
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

    const image = `<image x="${posX}" y="${posY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" xlink:href="data:png;base64,${
      data[index]
    }"/>`
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
