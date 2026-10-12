/**
 * The `agent-peers` command tree. v0 M2 ships `mcp` and `hook`; the installer, `join`, `hub` and the
 * shell commands arrive in M3 as further command modules.
 */
import { Command, CommanderError } from 'commander'
import { type HookCommandDeps, hookCommand } from './commands/hook'
import { type McpCommandDeps, mcpCommand } from './commands/mcp'
import { type CliIo, processIo } from './io'
import { CLI_VERSION } from './version'

export interface ProgramDeps {
  readonly hook?: HookCommandDeps
  readonly mcp?: McpCommandDeps
}

/** undefined: a long-running command (the MCP bridge) owns the process from here. */
export type ExitCode = number | undefined

export function buildProgram(io: CliIo, setExit: (code: ExitCode) => void, deps: ProgramDeps = {}): Command {
  const program = new Command('agent-peers')
    .description('agent-peers: connect AI coding-agent sessions into shared rooms')
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.stdout(text), writeErr: (text) => io.stderr(text) })
  const commands = [mcpCommand(io, setExit, deps.mcp ?? {}), hookCommand(io, setExit, deps.hook ?? {})]
  // addCommand does not inherit settings: without this a subcommand error would process.exit().
  for (const command of commands) program.addCommand(command.copyInheritedSettings(program))
  return program
}

/** Runs the CLI with `argv` (without the node/bun and script entries). */
export async function main(
  argv: readonly string[],
  io: CliIo = processIo,
  deps: ProgramDeps = {},
): Promise<ExitCode> {
  let code: ExitCode = 0
  const program = buildProgram(
    io,
    (value) => {
      code = value
    },
    deps,
  )
  try {
    await program.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    io.stderr(`agent-peers: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  return code
}
