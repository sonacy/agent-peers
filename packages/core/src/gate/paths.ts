/**
 * Path checks for peer turns (ONBOARDING §5): every path must resolve inside the workspace root and
 * must not match a secret deny glob. Pure: symlink resolution, existence and file listing are
 * injected functions (gate/fs-probes.ts has the production ones).
 */
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'

/** Lists the files a recursive search of `dir` could read (absolute); undefined when unknown. */
export type ListFiles = (dir: string, options: { readonly repo: boolean }) => readonly string[] | undefined

export interface PathContext {
  /** Absolute workspace root (already a realpath). */
  readonly workspaceRoot: string
  /** Directory relative paths resolve against; default the workspace root. */
  readonly cwd?: string
  /** The user's home, for `~` expansion and `~/…` deny globs. */
  readonly userHome: string
  readonly denyGlobs: readonly string[]
  /** Resolves symlinks (fsRealpath); default: lexical only. */
  readonly realpath?: (path: string) => string
  /** True when an absolute path exists; default: every path is assumed to exist (strictest). */
  readonly exists?: (path: string) => boolean
  /** Files under a search root; without it recursive searches are refused (they can't be verified). */
  readonly listFiles?: ListFiles
  /** Compare paths and globs case-insensitively (macOS and Windows file systems). */
  readonly caseInsensitive?: boolean
}

export type PathVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/** Default for `PathContext.caseInsensitive`: APFS/HFS+ and NTFS are case-insensitive by default. */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

const folded = (ctx: PathContext, path: string): string =>
  (ctx.caseInsensitive ?? CASE_INSENSITIVE_FS) ? path.toLowerCase() : path

/** Absolute, normalized form of `path` as seen from the context's cwd, without resolving symlinks. */
export function lexicalPath(ctx: PathContext, path: string): string {
  const expanded = expandTilde(path, ctx.userHome)
  const base = ctx.cwd ? resolve(ctx.workspaceRoot, expandTilde(ctx.cwd, ctx.userHome)) : ctx.workspaceRoot
  return isAbsolute(expanded) ? normalize(expanded) : resolve(base, expanded)
}

/** Absolute, normalized form of `path` as seen from the context's cwd, symlinks resolved. */
export function resolveFrom(ctx: PathContext, path: string): string {
  const absolute = lexicalPath(ctx, path)
  return ctx.realpath ? ctx.realpath(absolute) : absolute
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export const insideWorkspace = (ctx: PathContext, path: string): boolean =>
  isInside(folded(ctx, ctx.workspaceRoot), folded(ctx, path))

const globCache = new Map<string, InstanceType<typeof Bun.Glob>>()

export function glob(pattern: string): InstanceType<typeof Bun.Glob> {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const created = new Bun.Glob(pattern)
  globCache.set(pattern, created)
  return created
}

/** A glob without `/` matches any single path segment; one with `~/` or `/` matches a path prefix. */
function matchesDenyGlob(pattern: string, absolute: string, home: string): boolean {
  if (pattern.startsWith('~/') || pattern.startsWith('/')) {
    const root = expandTilde(pattern, home)
    if (!/[*?[{]/.test(root)) return isInside(root, absolute)
    const segments = absolute.split('/')
    return segments.some((_, i) => glob(root).match(segments.slice(0, i + 1).join('/') || '/'))
  }
  const segments = absolute.split('/').filter((segment) => segment.length > 0)
  if (pattern.includes('/'))
    return glob(`**/${pattern}`).match(absolute) || glob(`**/${pattern}/**`).match(absolute)
  const matcher = glob(pattern)
  return segments.some((segment) => matcher.match(segment))
}

/** The first deny glob `absolute` matches, if any (case-folded on case-insensitive file systems). */
export function secretMatch(ctx: PathContext, absolute: string): string | undefined {
  const home = folded(ctx, ctx.userHome)
  const path = folded(ctx, absolute)
  return ctx.denyGlobs.find((pattern) => matchesDenyGlob(folded(ctx, pattern), path, home))
}

/**
 * Checks one path a tool would touch. Deny globs are matched against both the path as written and
 * its symlink-resolved form (a link named `config.txt` pointing at `.env`); the workspace check uses
 * the resolved form (a link to a directory outside the workspace).
 */
export function checkPath(ctx: PathContext, path: string): PathVerdict {
  if (path.includes('\u0000')) return { ok: false, reason: 'path contains a NUL byte' }
  const lexical = lexicalPath(ctx, path)
  const absolute = ctx.realpath ? ctx.realpath(lexical) : lexical
  const secret = secretMatch(ctx, lexical) ?? secretMatch(ctx, absolute)
  if (secret) return { ok: false, reason: `"${path}" matches the secret deny list (${secret})` }
  if (!insideWorkspace(ctx, absolute)) return { ok: false, reason: `"${path}" is outside the workspace root` }
  return { ok: true, path: absolute }
}

/** Checks several paths; the first failure wins. */
export function checkPaths(ctx: PathContext, paths: readonly string[]): PathVerdict | undefined {
  for (const path of paths) {
    const verdict = checkPath(ctx, path)
    if (!verdict.ok) return verdict
  }
  return undefined
}

/** True when `path` names something that exists (or existence is unknown: assume it does). */
export function pathExists(ctx: PathContext, path: string): boolean {
  return ctx.exists === undefined || ctx.exists(resolveFrom(ctx, path))
}

/** The literal directory prefix of a glob pattern (`src/**\/*.ts` → `src`). */
export function globBase(pattern: string): string {
  const segments = pattern.split('/')
  const literal: string[] = []
  for (const segment of segments) {
    if (/[*?[{]/.test(segment)) break
    literal.push(segment)
  }
  if (literal.length === segments.length) return pattern
  const base = literal.join('/')
  return base === '' ? (pattern.startsWith('/') ? '/' : '.') : base
}
