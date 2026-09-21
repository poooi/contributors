import fs from 'fs-extra'
import os from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  filenameToRepo,
  listCachedRepos,
  loadCachedData,
  loadRepoManifest,
  MANIFEST_FILENAME,
  repoToFilename,
  saveCachedData,
  saveRepoManifest,
} from './cache'
import { Stat, Week } from './types'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'contributors-cache-'))
})

afterEach(async () => {
  await fs.remove(dir)
})

const week = (w = 1): Week => ({ w, a: 1, d: 0, c: 1 })

const stats = (login: string, total = 1): Stat[] => [
  {
    total,
    weeks: [week()],
    author: { login } as unknown as Stat['author'],
  },
]

describe('archive filename mapping', () => {
  it('preserves underscores inside repo names', () => {
    expect(filenameToRepo('ruiii_poi_theme_paper_dark.json')).toBe(
      'ruiii/poi_theme_paper_dark',
    )
    expect(repoToFilename('ruiii/poi_theme_paper_dark')).toBe(
      'ruiii_poi_theme_paper_dark.json',
    )
  })

  it('round-trips plain names', () => {
    expect(filenameToRepo(repoToFilename('poooi/plugin-sunshine'))).toBe(
      'poooi/plugin-sunshine',
    )
  })
})

describe('archive persistence', () => {
  it('loads missing archives as null', async () => {
    expect(await loadCachedData('poooi/poi', dir)).toBeNull()
  })

  it('saves and reloads stats', async () => {
    const data = stats('Javran', 7)
    expect(await saveCachedData('Javran/poi-plugin-mo2', data, dir)).toBe(true)
    expect(await loadCachedData('Javran/poi-plugin-mo2', dir)).toEqual(data)
  })

  it('skips rewriting unchanged archives', async () => {
    const data = stats('Javran')
    expect(await saveCachedData('Javran/repo', data, dir)).toBe(true)
    expect(await saveCachedData('Javran/repo', data, dir)).toBe(false)
    expect(await saveCachedData('Javran/repo', stats('Javran', 2), dir)).toBe(true)
  })

  it('propagates persistence failures instead of pretending success', async () => {
    const file = join(dir, 'blocked')
    await fs.outputFile(file, 'not a directory')
    await expect(saveCachedData('poooi/poi', stats('a'), file)).rejects.toBeTruthy()
  })
})

describe('empty-week normalization', () => {
  it('omits zero-activity weeks without mutating the input', async () => {
    const input: Stat[] = [
      {
        total: 6,
        weeks: [
          { w: 1, a: 1, d: 0, c: 1 },
          { w: 2, a: 0, d: 0, c: 0 },
          { w: 3, a: 0, d: 0, c: 2 },
          { w: 4, a: 2, d: 0, c: 0 },
          { w: 5, a: 0, d: 3, c: 0 },
        ],
        author: { login: 'Alice' } as unknown as Stat['author'],
      },
    ]
    const snapshot = JSON.parse(JSON.stringify(input))

    expect(await saveCachedData('poooi/poi', input, dir)).toBe(true)
    expect(await loadCachedData('poooi/poi', dir)).toEqual([
      {
        total: 6,
        weeks: [
          { w: 1, a: 1, d: 0, c: 1 },
          { w: 3, a: 0, d: 0, c: 2 },
          { w: 4, a: 2, d: 0, c: 0 },
          { w: 5, a: 0, d: 3, c: 0 },
        ],
        author: { login: 'Alice' },
      },
    ])
    expect(input).toEqual(snapshot)
  })

  it('skips rewriting when only appended zero weeks change', async () => {
    const base: Stat[] = [
      {
        total: 3,
        weeks: [{ w: 1, a: 3, d: 1, c: 2 }],
        author: { login: 'Alice' } as unknown as Stat['author'],
      },
    ]
    const appended: Stat[] = [
      {
        total: 3,
        weeks: [
          { w: 1, a: 3, d: 1, c: 2 },
          { w: 2, a: 0, d: 0, c: 0 },
        ],
        author: { login: 'Alice' } as unknown as Stat['author'],
      },
    ]

    expect(await saveCachedData('poooi/poi', base, dir)).toBe(true)
    expect(await saveCachedData('poooi/poi', appended, dir)).toBe(false)
    expect(await loadCachedData('poooi/poi', dir)).toEqual(base)
  })

  it('retains all-zero contributors and null authors', async () => {
    const input: Stat[] = [
      {
        total: 0,
        weeks: [{ w: 1, a: 0, d: 0, c: 0 }],
        author: { login: 'Alice' } as unknown as Stat['author'],
      },
      { total: 0, weeks: [{ w: 1, a: 0, d: 0, c: 0 }], author: null },
    ]

    expect(await saveCachedData('poooi/poi', input, dir)).toBe(true)
    const loaded = (await loadCachedData('poooi/poi', dir))!
    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toMatchObject({ total: 0, weeks: [] })
    expect(loaded[1].author).toBeNull()
    expect(loaded[1].weeks).toEqual([])
  })

  it('normalizes a legacy archive that still contains empty weeks', async () => {
    const legacy: Stat[] = [
      {
        total: 1,
        weeks: [
          { w: 1, a: 1, d: 0, c: 1 },
          { w: 2, a: 0, d: 0, c: 0 },
        ],
        author: { login: 'Alice' } as unknown as Stat['author'],
      },
    ]
    await fs.outputFile(
      join(dir, 'poooi_poi.json'),
      `${JSON.stringify(legacy, null, 2)}\n`,
    )

    expect(await saveCachedData('poooi/poi', legacy, dir)).toBe(true)
    expect(await loadCachedData('poooi/poi', dir)).toEqual([
      {
        total: 1,
        weeks: [{ w: 1, a: 1, d: 0, c: 1 }],
        author: { login: 'Alice' },
      },
    ])
  })
})

describe('repo manifest', () => {
  it('lists archived repos, ignores the manifest, keeps underscores', async () => {
    await saveCachedData('poooi/poi', stats('a'), dir)
    await saveCachedData('ruiii/poi_theme_paper_dark', stats('b'), dir)
    await saveRepoManifest(['poooi/poi'], dir)
    const repos = await listCachedRepos(dir)
    expect(repos).toEqual(['poooi/poi', 'ruiii/poi_theme_paper_dark'])
    expect(repos).not.toContain(MANIFEST_FILENAME)
  })

  it('dedupes and sorts the manifest, skipping unchanged writes', async () => {
    expect(await saveRepoManifest(['b/repo', 'a/repo', 'a/repo'], dir)).toBe(true)
    expect(await loadRepoManifest(dir)).toEqual(['a/repo', 'b/repo'])
    expect(await saveRepoManifest(['a/repo', 'b/repo'], dir)).toBe(false)
  })
})
