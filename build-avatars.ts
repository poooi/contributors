import chalk from 'chalk'
import fs from 'fs-extra'
import { join } from 'path'
import { refreshAvatars } from './avatars'
import { ContributorSimple } from './types'

const distDir = join(__dirname, 'dist')

// Refresh public donors and avatar sprites from the already-published
// contributors list, without re-collecting GitHub stats. Useful for iterating
// on the website avatar artifact.
export const loadPublishedContributors = async (): Promise<
  ContributorSimple[]
> => {
  const filePath = join(distDir, 'contributors.json')
  if (!(await fs.pathExists(filePath))) {
    throw new Error('dist/contributors.json not found; run `npm run build` first')
  }
  const parsed = await fs.readJson(filePath)
  if (!Array.isArray(parsed)) {
    throw new Error('dist/contributors.json is not an array')
  }
  return parsed as ContributorSimple[]
}

const main = async (): Promise<void> => {
  try {
    const contributors = await loadPublishedContributors()
    const result = await refreshAvatars({ contributors })
    if (result.skipped) {
      console.warn(
        chalk.yellow('⚠️  avatars unchanged (kept the previous manifest)'),
      )
    } else {
      console.info(
        chalk.cyan(
          `⚡️ avatars refreshed for ${contributors.length} contributors and ${result.supporters.length} supporters`,
        ),
      )
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

if (require.main === module) {
  void main()
}
