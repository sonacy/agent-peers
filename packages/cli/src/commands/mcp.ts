/**
 * `agent-peers mcp --surface <s> [--selftest]` (ARCHITECTURE §2): runs the bridge as a stdio MCP
 * server with the surface's injector (Codex `codex queue`, Claude Code pull, Claude Desktop poll).
 */
import {
  type InjectorOptions,
  injectorFor,
  parseMcpArgs,
  type RunMcpOptions,
  runMcp,
} from '@agent-peers/bridge'
import { Command } from 'commander'
import type { CliIo } from '../io'

export interface McpCommandOptions {
  readonly surface?: string
  readonly selftest?: boolean
}

/** Seams for tests (streams, home, process ownership, how the Codex CLI is found and run). */
export interface McpCommandDeps extends Partial<Omit<RunMcpOptions, 'argv' | 'env' | 'injector'>> {
  readonly injectorOptions?: Partial<Omit<InjectorOptions, 'env'>>
}

/**
 * Starts the bridge. Resolves with an exit code for `--selftest`, or undefined while the bridge
 * serves (the process then ends when the agent closes stdin).
 */
export async function runMcpCommand(
  options: McpCommandOptions,
  io: CliIo,
  deps: McpCommandDeps = {},
): Promise<number | undefined> {
  const argv = [
    ...(options.surface === undefined ? [] : ['--surface', options.surface]),
    ...(options.selftest ? ['--selftest'] : []),
  ]
  const args = parseMcpArgs(argv)
  const { injectorOptions, ...rest } = deps
  const log = (line: string) => io.stderr(`[agent-peers] ${line}\n`)
  // A selftest never injects: don't probe the Codex CLI for it.
  const injector = args.selftest
    ? undefined
    : injectorFor(args.surface, { log, ...injectorOptions, env: io.env })
  await runMcp({
    argv,
    env: io.env,
    log,
    report: (line) => io.stderr(`${line}\n`),
    ...(injector === undefined ? {} : { injector }),
    ...rest,
  })
  return args.selftest ? 0 : undefined
}

export function mcpCommand(
  io: CliIo,
  setExit: (code: number | undefined) => void,
  deps: McpCommandDeps = {},
): Command {
  return new Command('mcp')
    .description('run the agent-peers bridge as a stdio MCP server')
    .requiredOption('--surface <surface>', 'claude-code, claude-desktop, codex or codex-desktop')
    .option('--selftest', 'build the bridge, report and exit')
    .action(async (options: McpCommandOptions) => {
      setExit(await runMcpCommand(options, io, deps))
    })
}
