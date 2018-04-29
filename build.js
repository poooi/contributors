const fetch = require('node-fetch')
const _ = require('lodash')
const { join } = require('path')
const Promise = require('bluebird')
const fs = require('fs-extra')
const HttpsProxyAgent = require('https-proxy-agent')
const sharp = require('sharp')

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

const MORE_PEOPLE = [
  {
    login: 'Season千',
    avatar_url: 'http://7xkd7e.com1.z0.glb.clouddn.com/season.jpg',
    html_url: 'http://www.pixiv.net/member.php?id=3991162',
  },
  {
    login: 'edwardaaaa',
    avatar_url: 'https://avatars1.githubusercontent.com/u/11089376?v=4',
    html_url: 'https://github.com/edwardaaaa',
  },
]

const ALIAS = {
  dazzyd: 'yukixz',
}

const IGNORES = [
  'codacy-badger',
]

const OVERWRITES = {
  Javran: {
    avatar_url: 'https://gist.githubusercontent.com/Javran/02ac7ebefc307829d02e5dc942f8ef28/raw/250x250.png',
  },
  magicae: {
    html_url: 'http://weibo.com/maginya',
  },
  myzWILLmake: {
    html_url: 'http://weibo.com/myzwillmake',
  },
  Chibaheit: {
    html_url: 'http://weibo.com/chibaheit',
  },
  KochiyaOcean: {
    html_url: 'http://www.kochiyaocean.org',
  },
  malichan: {
    name: '马里酱',
    html_url: 'http://www.weibo.com/1791427467',
  },
  JenningsWu: {
    name: '吴钩霜雪明',
    html_url: 'http://www.weibo.com/jenningswu',
  },
  'Artoria-0x04': {
    html_url: 'http://www.weibo.com/pheliox',
  },
  zyc434343: {
    name: 'ZYC',
    html_url: 'http://weibo.com/zyc43',
  },
  yukixz: {
    html_url: 'http://dazzyd.org/',
  },
}

const AUTH = process.env.auth || ''

const fetchOptions = {}

fetchOptions.agent = proxy ? new HttpsProxyAgent(proxy) : null
if (AUTH) {
  fetchOptions.headers = {
    Authorization: `Basic ${new Buffer(AUTH).toString('base64')}`,
  }
}

const get = async (url) => {
  try {
    const resp = await fetch(url, fetchOptions)
    return resp.json()
  } catch (e) {
    console.log(e)
    return Promise.reject(e)
  }
}

const reduceStat = (weeks, initStat = { a: 0, d: 0, c: 0 }) =>
  _.reduce(
    weeks,
    ({ a: _a, d: _d, c: _c }, { a, d, c }) => ({ a: a + _a, d: d + _d, c: c + _c }),
    initStat,
  )

const getFirstCommitTime = (weeks) => {
  const first = _.find(weeks, week => week.c > 0) || {}
  return first.w || Infinity
}

const AVATAR_SIZE = 64
const MARGIN = 10
const COLS = 12
const IMAGE_WIDTH = (AVATAR_SIZE * COLS) + (MARGIN * (COLS + 1))
const ROUND = new Buffer(
  `<svg><rect x="0" y="0" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" rx="${AVATAR_SIZE / 2}" ry="${AVATAR_SIZE / 2}"/></svg>`
)

const buildSvg = async (contributors) => {
  const data = await Promise.map(contributors,
    async ({ avatar_url: avatarUrl }) => {
      try {
        const resp = await fetch(avatarUrl, fetchOptions)
        const buf = await resp.buffer()
        const img = await sharp(buf)
          .resize(AVATAR_SIZE)
          .overlayWith(ROUND, { cutout: true })
          .png()
          .toBuffer()
        console.log('🎆', avatarUrl)
        return img.toString('base64')
      } catch (e) {
        console.error(`${avatarUrl}&size=${AVATAR_SIZE}`, e)
        return ''
      }
    },
  )
  let posX = MARGIN
  let posY = MARGIN
  const imgs = []
  _.each(contributors, (p, index) => {
    if (posX + MARGIN + AVATAR_SIZE > IMAGE_WIDTH) {
      posY += AVATAR_SIZE + MARGIN
      posX = MARGIN
    }

    const image = `<image x="${posX}" y="${posY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" xlink:href="data:png;base64,${data[index]}"/>`
    imgs.push(`<a xlink:href="${p.html_url}" target="_blank" id="${p.login}">
      ${image}
      <rect x="${posX - 2}" y="${posY - 2}" width="${AVATAR_SIZE + 4}" height="${AVATAR_SIZE + 4}" stroke="#B3E5FC" stroke-width="2" fill="none" rx="${(AVATAR_SIZE / 2) + 2}" ry="${(AVATAR_SIZE / 2) + 2}" />
    </a>`)

    posX += AVATAR_SIZE + MARGIN
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${IMAGE_WIDTH}" height="${posY + AVATAR_SIZE + MARGIN}">
${imgs.join('\n')}
</svg>`
}

const main = async () => {
  try {
    const repos = await get(ORG_REPOS)
    console.log('⚡️', ORG_REPOS)

    const contributorPerRepo = _.fromPairs(
      await Promise.map((repos.map(r => r.full_name).concat(MORE_REPO)), async (name) => {
        const url = `https://api.github.com/repos/${name}/stats/contributors`
        const people = await get(url)
        console.log('⚡️', url)
        return [name, people]
      })
    )

    const contributors = {}

    await Promise.each(_.toPairs(contributorPerRepo), async ([repoName, people]) =>
      Promise.each(people, async ({
        total
        , weeks,
        author: { login: originalLogin, id, avatar_url, html_url },
      }) => {
        const login = ALIAS[originalLogin] || originalLogin
        if (!contributors[login]) {
          console.log(login)
          const user = await get(`https://api.github.com/users/${login}`)
          contributors[login] = {
            login,
            name: user.name,
            id,
            avatar_url,
            html_url,
            total,
            stat: reduceStat(weeks),
            firstCommitTime: getFirstCommitTime(weeks),
            perRepo: {
              [repoName]: total,
            },
          }
        } else {
          contributors[login].total += total
          contributors[login].stat = reduceStat(weeks, contributors[login].stat)
          contributors[login].perRepo[repoName] = total
          contributors[login].firstCommitTime =
            Math.min(contributors[login].firstCommitTime, getFirstCommitTime(weeks))
        }
      })
    )

    const data = [
      ...MORE_PEOPLE,
      ..._.sortBy(_.merge(contributors, OVERWRITES), p => p.firstCommitTime),
    ].filter(p => !IGNORES.includes(p.login))
    // await fs.outputJson(join(__dirname, 'per-repo.json'), contributorPerRepo, { spaces: 2 })
    await fs.outputJson(join(__dirname, 'dist', 'contributors.json'), data, { spaces: 2 })
    // await fs.outputJson(
    //   join(__dirname, 'contributors-sorted.json'),
    //   _.sortBy(contributors, p => p.firstCommitTime),
    // { spaces: 2 })

    const img = await buildSvg(data)

    await fs.outputFile(join(__dirname, 'dist', 'graph.svg'), img)
  } catch (e) {
    console.warn(e)
  }
}

main()
