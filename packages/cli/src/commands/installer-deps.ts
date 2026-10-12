/** Seams shared by `add`, `remove` and `doctor`, so tests run them in-process against a temp HOME. */
import { resolvePeersHome } from '@agent-peers/core'
import { determineAgent } from '@vercel/detect-agent'
import { InvalidArgumentError } from 'commander'
import type { DetermineAgent } from '../agents/current'
import { createSys } from '../agents/sys'
import { AGENT_IDS, type AgentDetection, type AgentId, isAgentId, type Sys } from '../agents/types'
import type { CliIo } from '../io'
import { processIo } from '../io'
import { CLI_VERSION } from '../version'

export interface SelectOption {
  readonly value: AgentId
  readonly label: string
  readonly hint?: string
  readonly disabled?: boolean
}

/** The interactive multi-select; undefined when the user cancels. */
export type SelectPrompt = (
  options: readonly SelectOption[],
  initial: readonly AgentId[],
) => Promise<readonly AgentId[] | undefined>

export interface InstallerDeps {
  readonly sys?: (io: CliIo) => Sys
  /** `@vercel/detect-agent` (it reads process.env, so it only runs against the real process env). */
  readonly determineAgent?: DetermineAgent
  readonly prompt?: SelectPrompt
  /** Whether a human can answer prompts (default: stdin and stdout are TTYs). */
  readonly interactive?: boolean
  /** The binary `add` copies (default: the running compiled binary or $AGENT_PEERS_BINARY). */
  readonly sourceBinary?: string
  readonly version?: string
  readonly fetch?: typeof fetch
  /** Per-request deadline for doctor's hub and bridge probes. */
  readonly probeTimeoutMs?: number
}

export const sysFor = (io: CliIo, deps: InstallerDeps): Sys => deps.sys?.(io) ?? createSys({ env: io.env })

export const homeFor = (io: CliIo, sys: Sys): string => resolvePeersHome(io.env, sys.home)

export const versionFor = (deps: InstallerDeps): string => deps.version ?? CLI_VERSION

/** detect-agent reads process.env: only consult it when the CLI runs against that env. */
export function determineFor(io: CliIo, deps: InstallerDeps): DetermineAgent | undefined {
  if (deps.determineAgent) return deps.determineAgent
  return io.env === process.env ? determineAgent : undefined
}

export function interactiveFor(io: CliIo, deps: InstallerDeps): boolean {
  if (deps.interactive !== undefined) return deps.interactive
  return io === processIo && process.stdin.isTTY === true && process.stdout.isTTY === true
}

/** commander collector for repeatable `-a <agent...>` (also accepts comma lists). */
export function collectAgents(value: string, previous: readonly string[] = []): string[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  for (const name of names) {
    if (!isAgentId(name))
      throw new InvalidArgumentError(`unknown agent "${name}" (expected ${AGENT_IDS.join(', ')})`)
  }
  return [...previous, ...names]
}

/** One line per agent: `✓ Claude Code 2.1.296` / `✗ Codex CLI: too old`. */
export function detectionLine(detection: AgentDetection): string {
  const mark = detection.supported ? '+' : detection.detected ? '!' : '-'
  const version = detection.version ? ` ${detection.version}` : ''
  const engine = detection.engineVersion ? ` (engine ${detection.engineVersion})` : ''
  const why = detection.supported ? '' : `: ${detection.reason ?? 'not found'}`
  return `  ${mark} ${detection.label}${version}${engine}${why}`
}

/** Writes lines with a trailing newline each. */
export const printer =
  (io: CliIo) =>
  (...lines: readonly string[]): void => {
    if (lines.length > 0) io.stdout(`${lines.join('\n')}\n`)
  }

export const unique = <T>(items: readonly T[]): readonly T[] => [...new Set(items)]
