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
