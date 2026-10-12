/** The hub as a per-user service (launchd on macOS, systemd --user on Linux). */
import type { RunResult } from '../agents/types'

/** Runs a service manager command (`launchctl …`, `systemctl --user …`); tests pass a fake. */
export type ServiceRunner = (argv: readonly string[]) => Promise<RunResult>

/** What the unit runs. */
export interface ServiceSpec {
  /** Absolute path of the installed `agent-peers` binary. */
  readonly binary: string
  /** Arguments after the binary: `hub --data-dir … [flags]`. */
  readonly args: readonly string[]
  /** Environment for the hub process (e.g. AGENT_PEERS_HOME). */
  readonly env: Readonly<Record<string, string>>
  /** launchd writes stdout/stderr here; systemd uses the journal. */
  readonly logPath: string
  readonly workingDir: string
}

export interface ServiceStatus {
  readonly manager: 'launchd' | 'systemd'
  readonly unitPath: string
  readonly installed: boolean
  /** Known to the service manager. */
  readonly loaded: boolean
  readonly running: boolean
  readonly pid?: number
  readonly detail?: string
}

export interface ServiceContext {
  /** The user's home directory (unit files live below it). */
  readonly userHome: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly uid: number
  readonly run: ServiceRunner
}

export interface ServiceManager {
  readonly name: 'launchd' | 'systemd'
  unitPath(ctx: ServiceContext): string
  render(spec: ServiceSpec): string
  /** Loads (or reloads) the unit file already written at `unitPath`. Returns progress lines. */
  activate(ctx: ServiceContext): Promise<readonly string[]>
  /** Stops and unloads the unit; the caller removes the file. */
  deactivate(ctx: ServiceContext): Promise<readonly string[]>
  /** Runs after the unit file was removed (systemd: daemon-reload). */
  afterRemove?(ctx: ServiceContext): Promise<void>
  status(ctx: ServiceContext, installed: boolean): Promise<ServiceStatus>
  /** What to tell the user after install (logs, linger). */
  hints(ctx: ServiceContext, spec: ServiceSpec): readonly string[]
}
