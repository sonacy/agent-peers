/** Editing an agent's own config files: a timestamped backup first, then an atomic replace that keeps the mode. */
import { randomBytes } from 'node:crypto'
import { chmod, chown, copyFile, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** `<file>.agent-peers-<UTC stamp>.bak`, next to the file. */
export function backupPath(path: string, now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${path}.agent-peers-${stamp}.bak`
}

/** Copies `path` to its backup; undefined when the file does not exist. */
export async function backupFile(path: string, now: number): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined)
  if (!info) return undefined
  const target = backupPath(path, now)
  await copyFile(path, target)
  await chmod(target, info.mode & 0o777)
  return target
}

/** True when running as root (sudo): the only case where a replaced file's owner can be kept. */
const isRoot = (): boolean => process.getuid?.() === 0

/**
 * Atomic write in the same directory; an existing file keeps its mode (and, as root, its owner), a
 * new one gets `mode`. A symlinked config (stow, chezmoi, home-manager) is written through: the
 * link's target is replaced, the link itself stays.
 */
export async function writeFileAtomic(path: string, text: string, mode = 0o644): Promise<void> {
  const target = await realpath(path).catch(() => path)
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const existing = await stat(target).catch(() => undefined)
  const finalMode = existing ? existing.mode & 0o777 : mode
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, text, { mode: finalMode, flag: 'wx' })
    await chmod(tmp, finalMode)
    if (existing && isRoot()) await chown(tmp, existing.uid, existing.gid)
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Backs up (when present) and replaces `path`. Returns the backup path. */
export async function replaceWithBackup(
  path: string,
  text: string,
  now: number,
): Promise<string | undefined> {
  const backup = await backupFile(path, now)
  await writeFileAtomic(path, text)
  return backup
}
