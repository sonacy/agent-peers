/**
 * The root command and the run loop, independent of which commands are mounted: global flags
 * (`--home <dir>`, `--json`, `--verbose`), commander output through `io`, and error rendering
 * (`agent-peers: <message> [<code>]`, exit codes from `errors.ts`).
 */
import { Command, CommanderError } from 'commander'
import { EXIT, renderError } from './errors'
import { homeFlag, withHome } from './globals'
import type { CliIo } from './io'
import { CLI_VERSION } from './version'

/** undefined: a long-running command (the MCP bridge) owns the process from here. */
export type ExitCode = number | undefined

export type SetExit = (code: ExitCode) => void

/** Builds the commands to mount, given the (possibly `--home`-scoped) io and the exit setter. */
export type CommandFactory = (io: CliIo, setExit: SetExit) => readonly Command[]

/** Copies the root's output and exit settings down the whole tree (commander only copies on create). */
function inherit(command: Command, from: Command): Command {
  command.copyInheritedSettings(from)
  for (const sub of command.commands) inherit(sub, command)
  return command
}

export interface RootOptions {
  /** `--json`: commander's own parse errors are rendered as a JSON envelope instead. */
  readonly json?: boolean
}

export function createRoot(io: CliIo, commands: readonly Command[], options: RootOptions = {}): Command {
  const root = new Command('agent-peers')
    .description('agent-peers: connect AI coding-agent sessions into shared rooms')
    .version(CLI_VERSION)
    .option('--home <dir>', 'agent-peers home (default: $AGENT_PEERS_HOME or ~/.agent-peers)')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'more detail, including stack traces on errors')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      ...(options.json ? { outputError: () => undefined } : {}),
    })
  // A subcommand that doesn't inherit settings would process.exit() on a usage error.
  for (const command of commands) root.addCommand(inherit(command, root))
  return root
}

/** `--json` / `--verbose` before the program could parse them (for errors thrown by parsing itself). */
export function earlyFlags(argv: readonly string[]): { readonly json: boolean; readonly verbose: boolean } {
  const end = argv.indexOf('--')
  const head = end === -1 ? argv : argv.slice(0, end)
  return { json: head.includes('--json'), verbose: head.includes('--verbose') }
}

/**
 * Commands whose exit code an agent interprets: a hook's exit 2 wakes the agent (ARCHITECTURE §5),
 * so a parse error there keeps commander's 1 instead of the usage code.
 */
const AGENT_EXIT_COMMANDS: ReadonlySet<string> = new Set(['hook'])

/** The subcommand named in `argv` (global flags and `--home <dir>` skipped). */
export function commandName(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--') return undefined
    if (arg === '--home') i += 1
    else if (!arg.startsWith('-')) return arg
  }
  return undefined
}

/**
 * A commander parse error (unknown option or command, missing or invalid argument) is a usage error:
 * exit 2, and with `--json` the same `{ error: { code, message } }` envelope `renderError` prints.
 * Help and `--version` keep commander's exit code (0); so do agent-facing commands (a hook).
 */
export function commanderExit(io: CliIo, error: CommanderError, argv: readonly string[]): number {
  if (error.exitCode === 0) return 0
  if (earlyFlags(argv).json) {
    const message = error.message.replace(/^error: /, '')
    io.stdout(`${JSON.stringify({ error: { code: 'invalid_params', message } })}\n`)
  }
  const name = commandName(argv)
  return name !== undefined && AGENT_EXIT_COMMANDS.has(name) ? error.exitCode : EXIT.usage
}

/** Parses `argv` (without the node/bun and script entries) and runs the matching command. */
export async function runRoot(
  argv: readonly string[],
  baseIo: CliIo,
  factory: CommandFactory,
): Promise<ExitCode> {
  const io = withHome(baseIo, homeFlag(argv))
  let code: ExitCode = 0
  const setExit: SetExit = (value) => {
    code = value
  }
  const flags = earlyFlags(argv)
  const root = createRoot(io, factory(io, setExit), { json: flags.json })
  try {
    await root.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) return commanderExit(io, error, argv)
    return renderError(io, error, flags)
  }
  return code
}
