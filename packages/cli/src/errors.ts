/**
 * Exit codes and error rendering shared by every command: a PeersError prints its code and human
 * message (`--json` prints `{ error: { code, message } }` on stdout instead), anything else is
 * `internal`. `--verbose` adds the stack.
 */
import { type ErrorCode, PeersError, toPeersError } from '@agent-peers/protocol'
import type { CliIo } from './io'

export const EXIT = Object.freeze({
  ok: 0,
  failure: 1,
  /** Bad flags or arguments. */
  usage: 2,
  /** The agent's sandbox blocked the command (ONBOARDING §3 step 2). */
  sandbox: 3,
  /** The hub (or its admin listener) could not be reached. */
  unreachable: 4,
  /** A token was missing, wrong or not allowed to do this. */
  auth: 5,
})

const USAGE_CODES: ReadonlySet<ErrorCode> = new Set(['invalid_params', 'invalid_name', 'invalid_request'])
const UNREACHABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'not_connected',
  'disconnected',
  'closed',
  'timeout',
])
const AUTH_CODES: ReadonlySet<ErrorCode> = new Set(['unauthorized', 'forbidden'])

export function exitCodeFor(error: PeersError): number {
  if (USAGE_CODES.has(error.code)) return EXIT.usage
  if (UNREACHABLE_CODES.has(error.code)) return EXIT.unreachable
  if (AUTH_CODES.has(error.code)) return EXIT.auth
  return EXIT.failure
}

export interface RenderOptions {
  readonly json?: boolean
  readonly verbose?: boolean
}

/** Prints `error` and returns the exit code for it. */
export function renderError(io: CliIo, error: unknown, options: RenderOptions = {}): number {
  const peers = toPeersError(error)
  if (options.json) {
    io.stdout(`${JSON.stringify({ error: { code: peers.code, message: peers.message } })}\n`)
  } else {
    io.stderr(`agent-peers: ${peers.message} [${peers.code}]\n`)
  }
  if (options.verbose) {
    const stack = (error instanceof Error ? error : peers).stack
    if (stack) io.stderr(`${stack}\n`)
  }
  return exitCodeFor(peers)
}

/** Usage errors raised by the commands themselves (bad flag values, conflicting flags). */
export function usageError(message: string): PeersError {
  return new PeersError('invalid_params', message)
}
