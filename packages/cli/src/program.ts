/**
 * The `agent-peers` command tree: the installer (`add`, `remove`, `doctor`), joining and the shell
 * commands, the hub and its admin commands, and the agent entrypoints (`mcp`, `hook`). The root
 * (global flags, error rendering, exit codes) lives in `root.ts`.
 */
import type { Command } from 'commander'
import { addCommand } from './commands/add'
import { askCommand } from './commands/ask'
import { dashboardCommand } from './commands/dashboard'
import { doctorCommand } from './commands/doctor'
import { type HookCommandDeps, hookCommand } from './commands/hook'
import { type HubCommandDeps, hubCommand } from './commands/hub'
import { inboxCommand } from './commands/inbox'
import type { InstallerDeps } from './commands/installer-deps'
import { type AdminCommandDeps, inviteCommand } from './commands/invite'
import { joinCommand } from './commands/join'
import { knockCommand } from './commands/knock'
import { leaveCommand } from './commands/leave'
import { type McpCommandDeps, mcpCommand } from './commands/mcp'
import { removeCommand } from './commands/remove'
import { renameCommand } from './commands/rename'
import { roomsCommand } from './commands/rooms'
import { sayCommand } from './commands/say'
import { statusCommand } from './commands/status'
import { versionCommand } from './commands/version'
import { whoCommand } from './commands/who'
import { type CliIo, processIo } from './io'
import { createRoot, type ExitCode, runRoot, type SetExit } from './root'

export type { ExitCode } from './root'

export interface ProgramDeps {
  readonly hook?: HookCommandDeps
  readonly mcp?: McpCommandDeps
  /** `add`, `remove` and `doctor`. */
  readonly installer?: InstallerDeps
  /** `hub` and its subcommands. */
  readonly hub?: HubCommandDeps
  /** `invite` and `rooms`. */
  readonly admin?: AdminCommandDeps
}

export function allCommands(io: CliIo, setExit: SetExit, deps: ProgramDeps = {}): readonly Command[] {
  const installer = deps.installer ?? {}
  return [
    addCommand(io, setExit, installer),
    removeCommand(io, setExit, installer),
    doctorCommand(io, setExit, installer),
    joinCommand(io, setExit),
    whoCommand(io, setExit),
    askCommand(io, setExit),
    sayCommand(io, setExit),
    inboxCommand(io, setExit),
    renameCommand(io, setExit),
    statusCommand(io, setExit),
    leaveCommand(io, setExit),
    knockCommand(io, setExit),
    dashboardCommand(io, setExit),
    hubCommand(io, setExit, deps.hub ?? {}),
    inviteCommand(io, setExit, deps.admin ?? {}),
    roomsCommand(io, setExit, deps.admin ?? {}),
    versionCommand(io, setExit),
    mcpCommand(io, setExit, deps.mcp ?? {}),
    hookCommand(io, setExit, deps.hook ?? {}),
  ]
}

export function buildProgram(io: CliIo, setExit: SetExit, deps: ProgramDeps = {}): Command {
  return createRoot(io, allCommands(io, setExit, deps))
}

/** Runs the CLI with `argv` (without the node/bun and script entries). */
export function main(
  argv: readonly string[],
  io: CliIo = processIo,
  deps: ProgramDeps = {},
): Promise<ExitCode> {
  return runRoot(argv, io, (scoped, setExit) => allCommands(scoped, setExit, deps))
}
