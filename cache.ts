import fs from 'fs-extra'
import { join } from 'path'
import { Stat } from './types'

const CACHE_DIR = join(__dirname, 'cache')

// Get current month string (YYYY-MM)
export const getCurrentMonth = (): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

// Convert repo full name to safe filename (e.g., "poooi/poi" -> "poooi_poi.json")
const repoToFilename = (repoFullName: string): string => {
  return `${repoFullName.replace(/\//g, '_')}.json`
}

// Get the cache file path for a repo in a specific month
const getCacheFilePath = (repoFullName: string, month: string): string => {
  return join(CACHE_DIR, month, repoToFilename(repoFullName))
}

// Load cached data for a repo from the current month
export const loadCachedData = async (repoFullName: string): Promise<Stat[] | null> => {
  const currentMonth = getCurrentMonth()
  const filePath = getCacheFilePath(repoFullName, currentMonth)

  try {
    if (await fs.pathExists(filePath)) {
      const data = await fs.readJson(filePath)
      return data
    }
  } catch (error) {
    console.warn(`Failed to load cache for ${repoFullName}:`, error)
  }

  return null
}

// Save contributor data for a repo
export const saveCachedData = async (
  repoFullName: string,
  data: Stat[]
): Promise<void> => {
  const currentMonth = getCurrentMonth()
  const filePath = getCacheFilePath(repoFullName, currentMonth)

  try {
    await fs.ensureDir(join(CACHE_DIR, currentMonth))
    await fs.writeJson(filePath, data, { spaces: 2 })
  } catch (error) {
    console.error(`Failed to save cache for ${repoFullName}:`, error)
  }
}

// List all months that have cached data
export const listCachedMonths = async (): Promise<string[]> => {
  try {
    if (await fs.pathExists(CACHE_DIR)) {
      const entries = await fs.readdir(CACHE_DIR)

      const dirChecks = await Promise.all(
        entries.map(async (entry) => {
          const stat = await fs.stat(join(CACHE_DIR, entry))
          return { entry, isDir: stat.isDirectory() }
        })
      )

      return dirChecks
        .filter(({ isDir }) => isDir)
        .map(({ entry }) => entry)
        .sort()
    }
  } catch (error) {
    console.warn('Failed to list cached months:', error)
  }
  return []
}

// List all cached repos in a specific month
export const listCachedRepos = async (month: string): Promise<string[]> => {
  const monthDir = join(CACHE_DIR, month)

  try {
    if (await fs.pathExists(monthDir)) {
      const files = await fs.readdir(monthDir)
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', '').replace(/_/g, '/'))
    }
  } catch (error) {
    console.warn(`Failed to list cached repos for ${month}:`, error)
  }

  return []
}
