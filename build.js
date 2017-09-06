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
    return Promise.reject(e)
  }
}

const reduceStat = (weeks, initStat = { a: 0, d: 0, c: 0 }) =>
  _.reduce(weeks, ({ a: _a, d: _d, c: _c }, { a, d, c }) => ({ a: a + _a, d: d + _d, c: c + _c }), initStat)

const getFirstCommitTime = (weeks) => {
  const first = _.find(weeks, week => week.c > 0) || {}
  return first.w || Infinity
}

const main = async () => {
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

  _.each(_.toPairs(contributorPerRepo), ([repoName, people]) => {
    _.each(people, ({ total, weeks, author: { login: _login, id, avatar_url, html_url } }) => {
      const login = ALIAS[_login] || _login
      if (!contributors[login]) {
        contributors[login] = {
          login,
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
  })

  console.log(_.sortBy(contributors, 'total').length, 'contributors')

  // await fs.outputJson(join(__dirname, 'per-repo.json'), contributorPerRepo, { spaces: 2 })
  await fs.outputJson(join(__dirname, 'contributors.json'), contributors, { spaces: 2 })
  await fs.outputJson(join(__dirname, 'contributors-sorted.json'), _.sortBy(contributors, p => p.firstCommitTime), { spaces: 2 })

  const img = await buildSvg([...MORE_PEOPLE, ..._.sortBy(contributors, p => p.firstCommitTime)])

  await fs.outputFile(join(__dirname, 'contributors.svg'), img)
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
    async ({ avatar_url}) => {
      try {
        const resp = await fetch(avatar_url, fetchOptions)
        const buf = await resp.buffer()
        const img = await sharp(buf).resize(AVATAR_SIZE).overlayWith(ROUND, { cutout: true }).png().toBuffer()
        return img.toString('base64')
      } catch (e) {
        console.error(`${avatar_url}&size=${AVATAR_SIZE}`, e)
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

main()
