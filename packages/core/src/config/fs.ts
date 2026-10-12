/** Private-file helpers: 0700 directories, 0600 files, atomic replace through a temp file. */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { PeersError } from '@agent-peers/protocol'
import type { z } from 'zod'
import { DIR_MODE, FILE_MODE } from './paths'

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error as { code: unknown }
  return typeof code === 'string' ? code : undefined
}

/** Creates `dir` (and parents) and forces mode 0700, whatever the umask or an earlier mode. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
}

/** Reads a file as text; `undefined` when it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw new PeersError('internal', `cannot read ${basename(path)}: ${String(error)}`, undefined, {
      cause: error,
    })
  }
}

/**
 * Writes `text` to `path` atomically: a 0600 temp file in the same directory, then a rename.
 * The parent directory is created 0700.
 */
export async function writePrivateFileAtomic(path: string, text: string): Promise<void> {
  const dir = dirname(path)
  await ensurePrivateDir(dir)
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' })
    await chmod(tmp, FILE_MODE)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw new PeersError('internal', `cannot write ${basename(path)}: ${String(error)}`, undefined, {
      cause: error,
    })
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * Reads and validates a JSON file. Missing → `fallback`. Malformed JSON or a schema mismatch →
 * `invalid_params`, naming the file so the user can fix it.
 */
export async function readJsonFile<S extends z.ZodType>(
  path: string,
  schema: S,
  fallback: () => z.output<S>,
): Promise<z.output<S>> {
  const text = await readTextIfExists(path)
  if (text === undefined || text.trim() === '') return fallback()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeersError('invalid_params', `${basename(path)} is not valid JSON`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new PeersError('invalid_params', `${basename(path)} is invalid: ${describeIssues(parsed.error)}`)
  return parsed.data
}

/** Validates, then writes pretty JSON atomically with mode 0600. */
export async function writeJsonFile<S extends z.ZodType>(path: string, schema: S, value: z.input<S>) {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new PeersError(
      'invalid_params',
      `refusing to write ${basename(path)}: ${describeIssues(parsed.error)}`,
    )
  await writePrivateFileAtomic(path, `${JSON.stringify(parsed.data, null, 2)}\n`)
  return parsed.data as z.output<S>
}
