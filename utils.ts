import bluebird from 'bluebird'
import _ from 'lodash'
import pRetry from 'p-retry'
import sharp from 'sharp'
import { ContributorSimple, Week } from './types'

const fetchOptions: RequestInit = {
  headers: {
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  },
}

const AVATAR_SIZE = 64
const AVATAR_RETRIES = 1
const AVATAR_TIMEOUT_MS = 5_000
const AVATAR_CONCURRENCY = 4
const MARGIN = 10
const COLS = 12
const IMAGE_WIDTH = AVATAR_SIZE * COLS + MARGIN * (COLS + 1)
const ROUND = Buffer.from(
  `<svg><rect x="0" y="0" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" rx="${AVATAR_SIZE /
    2}" ry="${AVATAR_SIZE / 2}"/></svg>`,
)

// Extract previously embedded base64 avatars from a generated graph.svg so a
// transient avatar fetch failure can reuse the last known-good image instead of
// failing the whole render (or dropping a known contributor).
export const parseEmbeddedAvatars = (svg: string): Map<string, string> => {
  const avatars = new Map<string, string>()
  const pattern = /id="([^"]+)"[\s\S]*?xlink:href="data:png;base64,([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(svg)) !== null) {
    avatars.set(match[1], match[2])
  }
  return avatars
}

export const getImage = async (url: string, fallback?: string): Promise<string> => {
  try {
    return await pRetry(
      async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS)
        try {
          const resp = await fetch(url, {
            ...fetchOptions,
            signal: controller.signal,
          })
          if (!resp.ok) {
            throw new Error(`avatar request failed with status ${resp.status}`)
          }
          const buf = await resp.arrayBuffer()
          const img = await sharp(Buffer.from(buf))
            .resize(AVATAR_SIZE)
            .composite([{ input: ROUND, blend: 'dest-in' }])
            .png()
            .toBuffer()
          console.info('🎆', url)
          return img.toString('base64')
        } finally {
          clearTimeout(timer)
        }
      },
      { retries: AVATAR_RETRIES },
    )
  } catch (error) {
    if (fallback) {
      console.warn(`⚠️  reusing existing embedded avatar for ${url}`)
      return fallback
    }
    console.error(url, error)
    throw error
  }
}

export const reduceStat = (
  weeks: Week[],
  initStat: Pick<Week, 'a' | 'd' | 'c'> = { a: 0, d: 0, c: 0 },
): Pick<Week, 'a' | 'd' | 'c'> =>
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

export interface BuildSvgOptions {
  /**
   * Previously generated SVG; its embedded base64 avatars are used as a
   * fallback when an avatar URL cannot be fetched.
   */
  existingSvg?: string
  /**
   * Replace the default avatar loader. Used by the build to reuse already
   * fetched/archived avatars instead of fetching each contributor twice.
   */
  getImage?: (url: string, fallback?: string) => Promise<string>
}

const escapeXmlAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export const buildSvg = async (
  contributors: ContributorSimple[],
  options: BuildSvgOptions = {},
): Promise<string> => {
  const embedded = options.existingSvg
    ? parseEmbeddedAvatars(options.existingSvg)
    : new Map<string, string>()
  const loadImage = options.getImage ?? getImage
  const data = await bluebird.map(
    contributors,
    ({ avatar_url, login }) => loadImage(avatar_url, embedded.get(login)),
    { concurrency: AVATAR_CONCURRENCY },
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
    imgs.push(`<a xlink:href="${escapeXmlAttribute(
      p.html_url,
    )}" target="_blank" id="${escapeXmlAttribute(p.login)}">
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
