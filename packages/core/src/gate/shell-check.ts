/**
 * Checks parsed shell commands against the peer-turn command allowlist (`git log`, `rg`, `cat`, …).
 * Each simple command must start with an allowlisted prefix, must not use a flag that writes, runs
 * a program or widens what is read, every path-like argument must pass the path checks, and a
 * recursive read (rg over a directory, git patches) must not reach a secret (gate/exposure.ts).
 */
import { type ExposureRequest, exposureProblem } from './exposure'
import { checkPath, type PathContext, pathExists } from './paths'
import { commandFromInput, parseShell } from './shell-parse'
import {
  type CommandSpec,
  GENERIC,
  GIT_NO_PATCH,
  GIT_PATCH_LONG,
  GIT_PATCH_SHORT,
  SPECS,
} from './shell-specs'

export type ShellVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Matches a simple command against an allowlist entry such as `git log`; returns the rest. */
function matchPrefix(words: readonly string[], entry: string): readonly string[] | undefined {
  const prefix = entry.trim().split(/\s+/)
  const normalized = words[0] === 'git' && words[1] === '--no-pager' ? ['git', ...words.slice(2)] : words
  if (prefix.length > normalized.length) return undefined
  return prefix.every((word, i) => normalized[i] === word) ? normalized.slice(prefix.length) : undefined
}

function deniedLongFlag(spec: CommandSpec, name: string): string | undefined {
  return spec.deny.find((d) => d.startsWith('--') && (name === d || name.startsWith(`${d}-`)))
}

interface FlagValue {
  readonly flag: string
  readonly value: string
}

interface Scan {
  readonly flags: ReadonlySet<string>
  readonly values: readonly FlagValue[]
  readonly positionals: readonly string[]
  /** Arguments after `--` (always operands). */
  readonly dashed: readonly string[]
  readonly patternGiven: boolean
  readonly reason?: string
}

interface ScanState {
  readonly flags: Set<string>
  readonly values: FlagValue[]
  pending?: string
  patternGiven: boolean
}

const known = (spec: CommandSpec, flag: string): boolean =>
  spec.allow === undefined || spec.allow.has(flag) || spec.valueFlags.has(flag)

/** GNU getopt accepts unambiguous prefixes (`--reg` for `--regexp`): count those as pattern flags too. */
function suppliesPattern(spec: CommandSpec, flag: string): boolean {
  const flags = spec.patternFlags
  if (flags === undefined) return false
  if (flags.has(flag)) return true
  return flag.startsWith('--') && flag.length >= 4 && [...flags].some((f) => f.startsWith(flag))
}

/** One flag (letter or long name): deny/allow checks, then record it. Returns a refusal reason. */
function noteFlag(spec: CommandSpec, state: ScanState, flag: string, shown: string): string | undefined {
  const isLong = flag.startsWith('--')
  if (isLong ? deniedLongFlag(spec, flag) : spec.deny.includes(flag))
    return `flag ${shown} is not allowed during a peer turn`
  if (!known(spec, flag)) return `flag ${shown} is not on the peer-turn flag allowlist`
  state.flags.add(flag)
  if (suppliesPattern(spec, flag)) state.patternGiven = true
  return undefined
}

/**
 * A short-flag cluster such as `-in5`, `-tjs` or `-ie PATTERN`: letters are flags until the first
 * value flag, whose value is the rest of the cluster or, when nothing is attached, the next arg.
 */
function scanShort(spec: CommandSpec, state: ScanState, arg: string): string | undefined {
  const letters = arg.slice(1)
  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i] as string
    const problem = noteFlag(spec, state, letter, `-${letter} (in ${arg})`)
    if (problem) return problem
    if (!spec.valueFlags.has(letter)) continue
    const attached = letters.slice(i + 1)
    if (attached === '') state.pending = letter
    else state.values.push({ flag: letter, value: attached })
    return undefined
  }
  return undefined
}

function scanLong(spec: CommandSpec, state: ScanState, arg: string): string | undefined {
  const [name, value] = arg.split(/=(.*)/s) as [string, string | undefined]
  const problem = noteFlag(spec, state, name, arg)
  if (problem) return problem
  if (value !== undefined) state.values.push({ flag: name, value })
  else if (spec.valueFlags.has(name)) state.pending = name
  return undefined
}

function scanArgs(spec: CommandSpec, args: readonly string[]): Scan {
  const state: ScanState = { flags: new Set(), values: [], patternGiven: false }
  const positionals: string[] = []
  const dashed: string[] = []
  let afterDashes = false
  for (const arg of args) {
    if (state.pending !== undefined) {
      state.values.push({ flag: state.pending, value: arg })
      state.pending = undefined
    } else if (afterDashes) dashed.push(arg)
    else if (arg === '--') afterDashes = true
    else if (arg === '-' || !arg.startsWith('-')) positionals.push(arg)
    else {
      const reason = arg.startsWith('--') ? scanLong(spec, state, arg) : scanShort(spec, state, arg)
      if (reason) return { ...state, positionals, dashed, reason }
    }
  }
  return { flags: state.flags, values: state.values, positionals, dashed, patternGiven: state.patternGiven }
}

/** `rev:path`, `:path`, `:0:path` and `-L1,9:path` name a path too; `-` is stdin. */
function pathsInArg(arg: string): readonly string[] {
  if (arg === '-' || arg === '') return []
  const colon = arg.indexOf(':')
  if (colon < 0 || arg.startsWith('/')) return [arg]
  const candidates = [arg, arg.slice(colon + 1), arg.slice(arg.lastIndexOf(':') + 1)]
  return [...new Set(candidates.filter((p) => p !== ''))]
}

interface Operands {
  /** Explicit paths: checked with checkPath. */
  readonly paths: readonly string[]
  /** The presumed search pattern: checked only when it names an existing path. */
  readonly pattern?: string
  /** File and directory operands (not flag values). */
  readonly operands: readonly string[]
}

function operandsOf(spec: CommandSpec, scan: Scan): Operands {
  const flagPaths = scan.values.filter((v) => spec.pathFlags.has(v.flag)).map((v) => v.value)
  const presumed = spec.patternFirst === true && !scan.patternGiven ? scan.positionals[0] : undefined
  const operands = [
    ...(presumed === undefined ? scan.positionals : scan.positionals.slice(1)),
    ...scan.dashed,
  ]
  return {
    paths: [...flagPaths, ...operands].flatMap(pathsInArg),
    ...(presumed === undefined ? {} : { pattern: presumed }),
    operands,
  }
}

const valuesOf = (scan: Scan, flags: ReadonlySet<string> | undefined): readonly string[] =>
  flags === undefined ? [] : scan.values.filter((v) => flags.has(v.flag)).map((v) => v.value)

/** rg reads every file under each operand (default: the cwd). */
function rgExposure(spec: CommandSpec, scan: Scan, operands: readonly string[]): readonly ExposureRequest[] {
  if (scan.flags.has('--type-list') || scan.flags.has('--help') || scan.flags.has('--version')) return []
  const filters = { globs: valuesOf(scan, spec.globFlags), iglobs: valuesOf(scan, spec.iglobFlags) }
  const roots = operands.length > 0 ? operands : ['.']
  return roots.map((root) => ({ root, filters }))
}

function gitPrintsPatches(subcommand: string, scan: Scan): boolean {
  const flags = [...scan.flags]
  const patch = flags.some(
    (f) => GIT_PATCH_SHORT.has(f) || GIT_PATCH_LONG.some((p) => f === p || f.startsWith(`${p}-`)),
  )
  if (subcommand === 'log') return patch
  if (subcommand !== 'diff' && subcommand !== 'show') return false
  const suppressed = flags.some(
    (f) => f === 's' || GIT_NO_PATCH.some((n) => f === n || f.startsWith(`${n}-`)),
  )
  return patch || !suppressed
}

/** git patches read every file under the pathspec, or the whole repository without one. */
function gitExposure(ctx: PathContext, words: readonly string[], scan: Scan): readonly ExposureRequest[] {
  const subcommand = (words[1] === '--no-pager' ? words[2] : words[1]) ?? ''
  if (!gitPrintsPatches(subcommand, scan)) return []
  const blobs = scan.positionals.filter((p) => p.includes(':'))
  const roots = [...scan.positionals.filter((p) => !p.includes(':') && pathExists(ctx, p)), ...scan.dashed]
  if (roots.length > 0) return roots.map((root) => ({ root }))
  return blobs.length > 0 ? [] : [{ root: '.', repo: true }]
}

function checkSimpleCommand(
  words: readonly string[],
  allow: readonly string[],
  ctx: PathContext,
): ShellVerdict {
  const entry = allow.find((candidate) => matchPrefix(words, candidate) !== undefined)
  if (!entry)
    return { ok: false, reason: `"${words.slice(0, 2).join(' ')}" is not on the peer-turn command allowlist` }
  const command = words[0] as string
  const spec = SPECS[command] ?? GENERIC
  const scan = scanArgs(spec, matchPrefix(words, entry) ?? [])
  if (scan.reason) return { ok: false, reason: scan.reason }
  const { paths, pattern, operands } = operandsOf(spec, scan)
  const checked = pattern !== undefined && pathExists(ctx, pattern) ? [...paths, pattern] : paths
  for (const path of checked) {
    const verdict = checkPath(ctx, path)
    if (!verdict.ok) return verdict
  }
  const exposure =
    command === 'rg'
      ? rgExposure(spec, scan, operands)
      : command === 'git'
        ? gitExposure(ctx, words, scan)
        : []
  for (const request of exposure) {
    const problem = exposureProblem(ctx, request)
    if (problem) return { ok: false, reason: problem }
  }
  return { ok: true }
}

/** Checks a shell tool call's `command` (string or argv) against the allowlist and path rules. */
export function checkShellCommand(
  command: unknown,
  allow: readonly string[],
  ctx: PathContext,
): ShellVerdict {
  const input = commandFromInput(command)
  if (!input) return { ok: false, reason: 'the shell command is missing or malformed' }
  if ('argv' in input) return checkSimpleCommand(input.argv, allow, ctx)
  const parsed = parseShell(input.script)
  if (!parsed.ok) return { ok: false, reason: `${parsed.reason} during a peer turn` }
  for (const segment of parsed.segments) {
    const verdict = checkSimpleCommand(segment, allow, ctx)
    if (!verdict.ok) return verdict
  }
  return { ok: true }
}
