/**
 * Shared plumbing of the shell fallback commands: common options, the session, errors → exit codes,
 * and `--json` (one JSON document on stdout: the command's result, or `{ error: { code, message } }`
 * as `renderError` prints it).
 */
import { type ErrorCode, isPeersError } from '@agent-peers/protocol'
import { type Command, Command as CommanderCommand } from 'commander'
import { printer } from '../commands/installer-deps'
import { EXIT, exitCodeFor } from '../errors'
import { globalsOf } from '../globals'
import type { CliIo } from '../io'
import { describeFailure, type StopReport } from './errors'
import { NetworkError } from './hub-http'
import { HandleTakenError } from './membership'
import { type ShellContext, type ShellOptions, withShellSession } from './shell'
import type { PeersDeps } from './types'

export type Print = (...lines: readonly string[]) => void

/** The command's machine-readable result (`--json`); the last call wins. */
export type Emit = (data: Readonly<Record<string, unknown>>) => void

/** A command with `--hub`, `--session-key` and `--insecure`. */
export function shellCommand(name: string, description: string): Command {
  return new CommanderCommand(name)
    .description(description)
    .option('--hub <url>', 'the hub to use (default: your only hub, or default_hub)')
    .option('--session-key <key>', 'act as this agent session (default: the agent running this command)')
    .option('--insecure', 'allow plain ws:// to a public host')
}

const writeJson = (io: CliIo, value: unknown): void => io.stdout(`${JSON.stringify(value)}\n`)

/** The protocol code for a failure (`unreachable` for a hub that never answered). */
function errorCode(error: unknown): ErrorCode | 'unreachable' {
  if (isPeersError(error)) return error.code
  if (error instanceof NetworkError) return 'unreachable'
  return 'internal'
}

/** A hub error as `renderError` shows it (the hub's own message and `[code]`); else join's wording. */
function failureReport(error: unknown): StopReport {
  if (isPeersError(error) && !(error instanceof HandleTakenError))
    return { code: exitCodeFor(error), lines: [`agent-peers: ${error.message} [${error.code}]`] }
  return describeFailure(error)
}

/** Prints a failure: `agent-peers: <message> [code]`, or the JSON error envelope on stdout. */
export function printFailure(io: CliIo, json: boolean | undefined, error: unknown): number {
  const report = failureReport(error)
  if (!json) {
    io.stderr(`${report.lines.join('\n')}\n`)
    return report.code
  }
  const message = isPeersError(error) ? error.message : report.lines.join(' ').replace(/^agent-peers: /, '')
  writeJson(io, { error: { code: errorCode(error), message } })
  return report.code
}

/** A usage error found before any connection (exit 2). */
export function usageFailure(io: CliIo, options: { readonly json?: boolean }, message: string): number {
  if (options.json) writeJson(io, { error: { code: 'invalid_params', message } })
  else io.stderr(`agent-peers: ${message}\n`)
  return EXIT.usage
}

/** Runs `work` in the acting session; any failure prints one line (or the JSON error) and exits non-zero. */
export async function runShell(
  io: CliIo,
  deps: PeersDeps,
  options: ShellOptions,
  work: (ctx: ShellContext, print: Print, emit: Emit) => Promise<number | undefined>,
): Promise<number> {
  const print: Print = options.json ? () => undefined : printer(io)
  let result: Readonly<Record<string, unknown>> = {}
  const emit: Emit = (data) => {
    result = data
  }
  try {
    const code = (await withShellSession(io, deps, options, (ctx) => work(ctx, print, emit))) ?? EXIT.ok
    if (options.json) writeJson(io, result)
    return code
  } catch (error) {
    return printFailure(io, options.json, error)
  }
}

/** The shell options commander parsed, without the command's own, plus the global `--json`. */
export function shellOptions(
  options: {
    readonly hub?: string
    readonly sessionKey?: string
    readonly insecure?: boolean
  },
  command?: Command,
): ShellOptions {
  const json = command ? globalsOf(command).json === true : false
  return {
    ...(options.hub ? { hub: options.hub } : {}),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options.insecure ? { insecure: true } : {}),
    ...(json ? { json: true } : {}),
  }
}
