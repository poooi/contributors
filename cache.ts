import fs from 'fs-extra'
import { join } from 'path'
import { Stat } from './types'

// Single, version-controlled archive directory. Because this is a git repo, the
// archived contributor data is checked in and serves as the canonical snapshot;
// there is no need for per-month rotation.
const CACHE_DIR = join(__dirname, 'cache')

// Convert repo full name to safe filename (e.g., "poooi/poi" -> "poooi_poi.json")
const repoToFilename = (repoFullName: string): string => {
  return `${repoFullName.replace(/\//g, '_')}.json`
}

const getCacheFilePath = (repoFullName: string): string => {
  return join(CACHE_DIR, repoToFilename(repoFullName))
}

// Load archived data for a repo. Returns null when no archive exists.
export const loadCachedData = async (repoFullName: string): Promise<Stat[] | null> => {
  const filePath = getCacheFilePath(repoFullName)

  try {
    if (await fs.pathExists(filePath)) {
      return await fs.readJson(filePath)
    }
  } catch (error) {
    console.warn(`Failed to load cache for ${repoFullName}:`, error)
  }

  return null
}

// Save contributor data for a repo into the archive.
export const saveCachedData = async (
  repoFullName: string,
  data: Stat[]
): Promise<void> => {
  const filePath = getCacheFilePath(repoFullName)

  try {
    await fs.ensureDir(CACHE_DIR)
    await fs.writeJson(filePath, data, { spaces: 2 })
  } catch (error) {
    console.error(`Failed to save cache for ${repoFullName}:`, error)
  }
}

// List all repos that have archived data.
export const listCachedRepos = async (): Promise<string[]> => {
  try {
    if (await fs.pathExists(CACHE_DIR)) {
      const files = await fs.readdir(CACHE_DIR)
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', '').replace(/_/g, '/'))
    }
  } catch (error) {
    console.warn('Failed to list cached repos:', error)
  }

  return []
}

// Archive a given (owner, repo, data) snapshot into the archive directory.
// Used by the migration utility to flatten historical month dirs into the
// single version-controlled archive.
export const archiveData = async (repoFullName: string, data: Stat[]): Promise<void> => {
  const filePath = getCacheFilePath(repoFullName)
  await fs.ensureDir(CACHE_DIR)
  await fs.writeJson(filePath, data, { spaces: 2 })
}
