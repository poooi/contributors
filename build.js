const fetch = require('node-fetch')
const _ = require('lodash')
const { join } = require('path')
const Promise = require('bluebird')
const fs = require('fs-extra')
const HttpsProxyAgent = require('https-proxy-agent')

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
]

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
    _.each(people, ({ total, weeks, author: { login, id, avatar_url, html_url } }) => {
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
}

main()
