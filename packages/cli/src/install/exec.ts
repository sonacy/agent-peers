/** Running an agent's own plugin CLI and reading its result (`--json` puts one object on the last line). */
import type { RunResult, Sys } from '../agents/types'

/** Plugin installs can fetch and copy; give them time, but never hang forever. */
export const CLI_STEP_TIMEOUT_MS = 180_000

export type JsonObject = { readonly [key: string]: unknown }

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The last stdout line that parses as JSON (any JSON value), or undefined. */
export function lastJsonValue(stdout: string): unknown {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i] ?? '')
    } catch {
      // not JSON: keep looking upwards
    }
  }
  return undefined
}

/** Whole stdout as JSON (list commands print a pretty array), else the last JSON line. */
export function parseJsonOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return lastJsonValue(stdout)
  }
}

export interface CliStep {
  readonly argv: readonly string[]
  readonly result: RunResult
  readonly ok: boolean
  /** The command reported the goal state was already reached (already installed / added). */
  readonly already: boolean
  readonly json?: JsonObject
}

export interface CliStepOptions {
  /** Output that means "already done" (treated as success, nothing changed). */
  readonly already?: RegExp
  readonly timeoutMs?: number
}

/** Shell-like rendering for output lines (`$ claude plugin install peers …`). */
export function formatArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** Runs one CLI step. `ok` follows `--json` `outcome` when present, else the exit code. */
export async function runCliStep(
  sys: Sys,
  argv: readonly string[],
  options: CliStepOptions = {},
): Promise<CliStep> {
  const result = await sys.run(argv, { timeoutMs: options.timeoutMs ?? CLI_STEP_TIMEOUT_MS })
  const parsed = lastJsonValue(result.stdout)
  const json = isJsonObject(parsed) ? parsed : undefined
  const output = `${result.stdout}\n${result.stderr}`
  const already = (options.already?.test(output) ?? false) || json?.alreadyInGoalState === true
  const reported = typeof json?.outcome === 'string' ? json.outcome === 'ok' : result.code === 0
  return { argv, result, ok: reported || already, already, ...(json ? { json } : {}) }
}

/** The most useful one-line reason a step failed. */
export function stepError(step: CliStep): string {
  if (step.result.timedOut) return 'timed out'
  const message = typeof step.json?.message === 'string' ? step.json.message : undefined
  const text = message ?? (step.result.stderr.trim() || step.result.stdout.trim())
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? `exit code ${step.result.code}`
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/** `  $ <argv>  → ok | already | failed: <reason>` */
export function describeStep(step: CliStep): string {
  const verdict = step.already ? 'already done' : step.ok ? 'ok' : `failed: ${stepError(step)}`
  return `$ ${formatArgv(step.argv)} -> ${verdict}`
}
