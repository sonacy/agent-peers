/**
 * Agent detection types (ARCHITECTURE §4 step 1). One entry per v0 target; everything a detector
 * touches goes through `Sys`, so tests run against a temp HOME, fake binaries and fake app bundles.
 */
import type { EnvLike } from '@agent-peers/core'

export const AGENT_IDS = ['claude-code', 'claude-desktop', 'codex', 'codex-desktop'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export const isAgentId = (value: string): value is AgentId => (AGENT_IDS as readonly string[]).includes(value)

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** True when the process was killed at the deadline. */
  readonly timedOut: boolean
}

export interface RunOptions {
  readonly timeoutMs?: number
  readonly cwd?: string
}

/** Everything detection and installation read from or do to the machine. */
export interface Sys {
  readonly env: EnvLike
  /** The user's home directory (`$HOME`). */
  readonly home: string
  readonly platform: NodeJS.Platform
  /** Where app bundles are looked up (default `/Applications`, `~/Applications`). */
  readonly appDirs: readonly string[]
  exists(path: string): Promise<boolean>
  isExecutable(path: string): Promise<boolean>
  readText(path: string): Promise<string | undefined>
  /** Entry names of a directory; empty when it does not exist. */
  listDir(path: string): Promise<readonly string[]>
  realpath(path: string): Promise<string>
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  now(): number
}

/** A binary found for an agent, after skipping wrapper shims. */
export interface FoundBinary {
  /** The path to run (a symlink is kept, so the agent's own updater keeps working). */
  readonly path: string
  /** Its resolved target. */
  readonly realPath: string
  readonly version?: string
  /** Where it came from: `PATH`, `CLAUDE_CODE_EXECPATH`, `app bundle`, … */
  readonly source: string
}

export interface AgentDetection {
  readonly id: AgentId
  readonly label: string
  /** Something of this agent exists on the machine (binary, app bundle or config dir). */
  readonly detected: boolean
  /** Detected, new enough and with what the installer needs (a binary or a config dir). */
  readonly supported: boolean
  /** Why an agent that was detected cannot be installed (too old, no binary). */
  readonly reason?: string
  readonly binary?: FoundBinary
  /** Agent version (app version for desktop apps). */
  readonly version?: string
  /** Engine version for desktop apps that bundle a CLI (Codex desktop). */
  readonly engineVersion?: string
  /** The agent's config directory (honoring CLAUDE_CONFIG_DIR / CODEX_HOME). */
  readonly configDir: string
  /** App bundle, when the agent is a desktop app. */
  readonly app?: string
  /** What was found, for `doctor` and `add --dry-run`. */
  readonly evidence: readonly string[]
  /** Non-blocking notes (e.g. push tier unavailable on this version). */
  readonly notes: readonly string[]
}
