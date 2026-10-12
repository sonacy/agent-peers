/**
 * Recursive reads (Grep, `rg PATTERN [DIR]`, `git diff`/`git show`/`git log -p`) touch every file
 * under their root, not just the paths they name. A search is allowed only when none of the files it
 * could read matches a secret deny glob, given its `--glob` filters (ONBOARDING §5). The file list
 * comes from the injected `listFiles`; without it, or when it can't answer, the search is refused.
 */
import { basename, relative } from 'node:path'
import { glob, insideWorkspace, type PathContext, resolveFrom, secretMatch } from './paths'

export interface SearchFilters {
  /** rg `--glob` / `--iglob` / Grep `glob` values; a leading `!` excludes. */
  readonly globs: readonly string[]
  /** `--iglob` values (case-insensitive). */
  readonly iglobs?: readonly string[]
}

export const NO_FILTERS: SearchFilters = { globs: [] }

/** Splits a Grep `glob` value the way a caller might list several: on whitespace and top-level commas. */
export function splitGlobList(value: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '{') depth++
    if (ch === '}') depth = Math.max(0, depth - 1)
    if ((ch === ',' && depth === 0) || /\s/.test(ch)) {
      if (current !== '') parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') parts.push(current)
  return parts
}

interface CompiledGlob {
  readonly negated: boolean
  readonly pattern: string
  readonly nocase: boolean
}

function compile(filters: SearchFilters): readonly CompiledGlob[] {
  const make = (raw: string, nocase: boolean): CompiledGlob => {
    const negated = raw.startsWith('!')
    const body = negated ? raw.slice(1) : raw
    return { negated, pattern: nocase ? body.toLowerCase() : body, nocase }
  }
  return [...filters.globs.map((g) => make(g, false)), ...(filters.iglobs ?? []).map((g) => make(g, true))]
}

/**
 * rg semantics, over-approximated: a glob without `/` matches the file name or any directory above
 * it, one with `/` the path below the root or a directory prefix of it.
 */
function globMatches(entry: CompiledGlob, rel: string): boolean {
  const target = entry.nocase ? rel.toLowerCase() : rel
  const pattern = entry.pattern.replace(/^\/+/, '')
  if (!pattern.includes('/')) return target.split('/').some((segment) => glob(pattern).match(segment))
  return glob(pattern).match(target) || glob(`${pattern}/**`).match(target)
}

/** Whether the search would read `rel` (relative to its root) given its glob filters. */
function selected(globs: readonly CompiledGlob[], rel: string): boolean {
  const positives = globs.filter((g) => !g.negated)
  if (globs.some((g) => g.negated && globMatches(g, rel))) return false
  return positives.length === 0 || positives.some((g) => globMatches(g, rel))
}

export interface ExposureRequest {
  /** The search root as the tool names it (file or directory, relative to the cwd). */
  readonly root: string
  readonly filters?: SearchFilters
  /** The whole repository containing the root (git without a pathspec). */
  readonly repo?: boolean
}

/** Why a recursive read of `request.root` is refused, or undefined when it reads no secret. */
export function exposureProblem(ctx: PathContext, request: ExposureRequest): string | undefined {
  const label = request.repo ? 'the repository' : `"${request.root}"`
  if (ctx.listFiles === undefined)
    return `cannot verify which files a search of ${label} reads; name the files to read instead`
  const root = resolveFrom(ctx, request.root)
  const files = ctx.listFiles(root, { repo: request.repo === true })
  if (files === undefined)
    return `${label} is too large to verify for secrets; search a narrower path or name the files`
  const globs = compile(request.filters ?? NO_FILTERS)
  for (const file of files) {
    if (!insideWorkspace(ctx, file))
      return `${label} includes files outside the workspace root (${file}); name a path inside it`
    const rel = relative(root, file) || basename(file)
    if (!selected(globs, rel)) continue
    const secret = secretMatch(ctx, file)
    if (secret)
      return `searching ${label} would read "${rel}", which matches the secret deny list (${secret}); search a narrower path or exclude it with a glob`
  }
  return undefined
}
