import fs from 'fs-extra'

// Write a file only when its bytes differ, replacing via a same-directory temp
// file so a partial write cannot leave a truncated file behind. Write errors
// propagate to the caller.
export const writeIfChanged = async (
  filePath: string,
  content: string | Buffer,
): Promise<boolean> => {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content)
  try {
    if (await fs.pathExists(filePath)) {
      const existing = await fs.readFile(filePath)
      if (existing.toString('hex') === next.toString('hex')) {
        return false
      }
    }
  } catch {
    // Fall through and rewrite; an unreadable file should be repaired.
  }
  const tempPath = `${filePath}.tmp`
  await fs.outputFile(tempPath, next)
  // Same-directory rename is atomic and replaces the destination directly.
  await fs.rename(tempPath, filePath)
  return true
}

export type Writer = (filePath: string, content: string | Buffer) => Promise<boolean>
