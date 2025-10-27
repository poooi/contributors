import bluebird from 'bluebird'
import chalk from 'chalk'
import HttpsProxyAgent from 'https-proxy-agent'
import _ from 'lodash'
import fetch, { RequestInit } from 'node-fetch'
import pRetry from 'p-retry'
import sharp from 'sharp'
import SocksProxyAgent from 'socks-proxy-agent'
import dotenv from 'dotenv'
import { ContributorSimple, Stat, Week } from './types'

dotenv.config()

const fetchOptions: RequestInit = {}

const proxy = process.env.https_proxy || process.env.http_proxy || ''
if (proxy) {
  const agent = /^socks/i.exec(proxy)
    ? new SocksProxyAgent(proxy)
    : new HttpsProxyAgent(proxy)
  fetchOptions.agent = agent
}

const AUTH: string = process.env.AUTH || ''
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

export const get = (url: string): Promise<any> =>
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
        return bluebird.reject(e)
      }
    },
    { retries: 5 },
  )

export const getContributors = async (owner: string, repo: string): Promise<Stat[]> => pRetry(
  async () => {
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/stats/contributors`
      const resp = await fetch(url, fetchOptions)
      if (!resp.ok)  {
        const parsed = await resp.json()
        console.error(chalk.red(`[ERROR] url: ${url}`), parsed)
        throw new Error(chalk.red('invalid response'))
      }
      if (resp.status === 202) {
        throw new Error(chalk.yellow(`Accepted ${url}`))
      }
      const data = await resp.json()
      if (!data) {
        throw new Error(chalk.red('falsy response'))
      }
      return data
    } catch (e) {
      console.info(e)
      return bluebird.reject(e)
    }
  },
  { retries: 10, minTimeout: 2000 },
)

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
