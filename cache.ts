import fs from 'fs-extra'
import { join } from 'path'
import { Stat } from './types'

// Single, version-controlled archive directory. Because this is a git repo, the
// archived contributor data is checked in and serves as the canonical snapshot;
// there is no need for per-month rotation.
export const CACHE_DIR = join(__dirname, 'cache')

// The repo manifest records every repo full name we have ever discovered. It is
// used as a bootstrap when the GitHub org discovery call fails, so a temporary
// outage does not silently drop repos (and their contributors) from the output.
export const MANIFEST_FILENAME = 'repos.json'

// Convert repo full name to safe filename (e.g., "poooi/poi" -> "poooi_poi.json")
export const repoToFilename = (repoFullName: string): string => {
  return `${repoFullName.replace('/', '_')}.json`
}

// Recover a repo full name from its archive filename. GitHub owner names cannot
// contain underscores, so splitting on the *first* underscore keeps repo names
// that do contain underscores intact (e.g. "ruiii_poi_theme_paper_dark" ->
// "ruiii/poi_theme_paper_dark").
export const filenameToRepo = (filename: string): string => {
  const base = filename.replace(/\.json$/, '')
  const index = base.indexOf('_')
  if (index < 0) {
    return base
  }
  return `${base.slice(0, index)}/${base.slice(index + 1)}`
}

const getCacheFilePath = (repoFullName: string, dir: string = CACHE_DIR): string => {
  return join(dir, repoToFilename(repoFullName))
}

const readFileIfChanged = async (
  filePath: string,
  content: string,
): Promise<boolean> => {
  try {
    if (await fs.pathExists(filePath)) {
      const existing = await fs.readFile(filePath, 'utf8')
      if (existing === content) {
        return false
      }
    }
  } catch {
    // Fall through and rewrite; a corrupt/unreadable archive should be repaired.
  }
  // Replace via a same-directory temp file so a partial write can never leave a
  // truncated archive behind.
  const tempPath = `${filePath}.tmp`
  await fs.outputFile(tempPath, content)
  await fs.move(tempPath, filePath, { overwrite: true })
  return true
}

const serialize = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`

// Load archived data for a repo. Returns null when no archive exists. A corrupt
// archive is treated as absent (and will be rebuilt from the API) rather than
// crashing the whole build.
export const loadCachedData = async (
  repoFullName: string,
  dir: string = CACHE_DIR,
): Promise<Stat[] | null> => {
  const filePath = getCacheFilePath(repoFullName, dir)

  try {
    if (await fs.pathExists(filePath)) {
      const parsed = await fs.readJson(filePath)
      return Array.isArray(parsed) ? (parsed as Stat[]) : null
    }
  } catch (error) {
    console.warn(`Failed to load cache for ${repoFullName}:`, error)
  }

  return null
}

// Save contributor data for a repo into the archive. Persistence errors are
// fatal: a build that cannot record its archive must not pretend to succeed.
// Writes are skipped when the serialized content is unchanged so archive files
// are never rewritten just because a run happened.
export const saveCachedData = async (
  repoFullName: string,
  data: Stat[],
  dir: string = CACHE_DIR,
): Promise<boolean> => {
  const filePath = getCacheFilePath(repoFullName, dir)
  await fs.ensureDir(dir)
  return readFileIfChanged(filePath, serialize(data))
}

// List all repos that have archived data.
export const listCachedRepos = async (dir: string = CACHE_DIR): Promise<string[]> => {
  try {
    if (await fs.pathExists(dir)) {
      const files = await fs.readdir(dir)
      return files
        .filter(file => file.endsWith('.json') && file !== MANIFEST_FILENAME)
        .map(filenameToRepo)
        .sort()
    }
  } catch (error) {
    console.warn('Failed to list cached repos:', error)
  }

  return []
}

export const loadRepoManifest = async (dir: string = CACHE_DIR): Promise<string[]> => {
  try {
    const filePath = join(dir, MANIFEST_FILENAME)
    if (await fs.pathExists(filePath)) {
      const parsed = await fs.readJson(filePath)
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === 'string')
      }
    }
  } catch (error) {
    console.warn('Failed to load repo manifest:', error)
  }
  return []
}

export const saveRepoManifest = async (
  repos: string[],
  dir: string = CACHE_DIR,
): Promise<boolean> => {
  const filePath = join(dir, MANIFEST_FILENAME)
  await fs.ensureDir(dir)
  return readFileIfChanged(filePath, serialize([...new Set(repos)].sort()))
}

// Archive a given (owner, repo, data) snapshot into the archive directory.
// Used by the migration utility to flatten historical month dirs into the
// single version-controlled archive.
export const archiveData = async (
  repoFullName: string,
  data: Stat[],
  dir: string = CACHE_DIR,
): Promise<boolean> => {
  return saveCachedData(repoFullName, data, dir)
}
