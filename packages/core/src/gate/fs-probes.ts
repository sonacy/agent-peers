/**
 * The file-system functions the bridge injects into the peer-turn gate (gate/paths.ts): symlink
 * resolution that also works for paths that don't exist yet, existence, and the list of files a
 * recursive search could read (`git ls-files` in a repository, a bounded walk elsewhere).
 */
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ListFiles } from './paths'

/**
 * `fs.realpathSync.native` of the deepest existing ancestor, with the rest re-appended, so a file a
 * write would create still resolves through a symlinked directory.
 */
export function fsRealpath(path: string): string {
  const tail: string[] = []
  let current = path
  for (;;) {
    try {
      const resolved = realpathSync.native(current)
      return tail.length === 0 ? resolved : join(resolved, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      tail.push(basename(current))
      current = parent
    }
  }
}

export function fsExists(path: string): boolean {
  return existsSync(path)
}

/** A search over more files than this can't be verified; the gate refuses it. */
export const MAX_LISTED_FILES = 50_000
const MAX_WALK_DEPTH = 32
const GIT_TIMEOUT_MS = 5_000

function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    return proc.exitCode === 0 ? proc.stdout.toString('utf8') : undefined
  } catch {
    return undefined
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

interface Listing {
  readonly files: string[]
  readonly max: number
  overflow: boolean
}

function push(listing: Listing, file: string): void {
  if (listing.files.length >= listing.max) listing.overflow = true
  else listing.files.push(file)
}

/** Every file under `dir` (hidden ones too, `.git` excepted): the superset of what rg could read. */
function walk(dir: string, listing: Listing, depth: number): void {
  if (listing.overflow) return
  if (depth > MAX_WALK_DEPTH) {
    listing.overflow = true
    return
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.git') walk(path, listing, depth + 1)
    } else push(listing, path)
    if (listing.overflow) return
  }
}

/**
 * Tracked plus untracked-but-not-ignored files: a superset of what rg reads (rg also honours
 * `.ignore` files). Nested repositories and submodules are listed as directories and walked.
 */
function gitList(dir: string, repo: boolean, listing: Listing): boolean {
  const top = repo ? runGit(dir, ['rev-parse', '--show-toplevel'])?.trim() : dir
  if (!top) return false
  const base = repo ? fsRealpath(top) : dir
  const out = runGit(base, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (out === undefined) return false
  for (const rel of new Set(out.split('\0').filter((p) => p !== ''))) {
    const path = join(base, rel)
    if (rel.endsWith('/') || isDirectory(path)) walk(path, listing, 1)
    else push(listing, path)
    if (listing.overflow) break
  }
  return true
}

function listOnce(dir: string, repo: boolean, max: number): readonly string[] | undefined {
  if (!existsSync(dir)) return []
  if (!isDirectory(dir)) return [dir]
  const listing: Listing = { files: [], max, overflow: false }
  const inRepo = runGit(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true'
  if (inRepo && gitList(dir, repo, listing)) return listing.overflow ? undefined : listing.files
  if (repo) return undefined
  walk(dir, listing, 0)
  return listing.overflow ? undefined : listing.files
}

export interface ListFilesOptions {
  readonly ttlMs?: number
  readonly now?: () => number
  readonly maxFiles?: number
}

/** `listFiles` with a short cache: one peer turn runs many searches over the same tree. */
export function cachedListFiles(options: ListFilesOptions = {}): ListFiles {
  const ttlMs = options.ttlMs ?? 5_000
  const now = options.now ?? Date.now
  const max = options.maxFiles ?? MAX_LISTED_FILES
  const cache = new Map<string, { readonly at: number; readonly files: readonly string[] | undefined }>()
  return (dir, request) => {
    const key = `${request.repo ? 'repo' : 'dir'}:${dir}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.files
    const files = listOnce(dir, request.repo, max)
    if (cache.size > 64) cache.clear()
    cache.set(key, { at: now(), files })
    return files
  }
}
