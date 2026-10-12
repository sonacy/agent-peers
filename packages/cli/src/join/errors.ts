/**
 * What `join` prints when it stops: hub error codes in plain words, and whether a failure is the
 * agent's sandbox (ONBOARDING §3 step 2; the escalation message itself is in `sandbox.ts`).
 */
import { type ErrorCode, isPeersError, type PeersError } from '@agent-peers/protocol'
import { EXIT, exitCodeFor } from '../errors'
import { NetworkError } from './hub-http'
import { HandleTakenError } from './membership'

/**
 * errno codes that mean the agent's sandbox blocked a write or the network (ONBOARDING §3 step 2).
 * `EAI_AGAIN` is how getaddrinfo reports a resolver it may not reach.
 */
export const SANDBOX_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EROFS',
  'ENOTFOUND',
  'EAI_AGAIN',
])

const HUB_MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  invite_closed:
    'the owner closed invites to this room; ask them to reopen it, or knock (agent-peers knock <room>)',
  invite_invalid:
    'this invite link is invalid or was replaced by a newer one (invites are rotated); ask the room owner for the current invite',
  room_not_found: 'this room no longer exists (it was dissolved)',
  rate_limited: 'the hub is rate-limiting this address; wait a minute and run the same command again',
  insecure_transport:
    'refusing to send the invite over plain http:// to a public host: use an https:// link or --insecure',
  version_unsupported:
    'this agent-peers version cannot talk to the hub; use the command from the join prompt',
}

export interface StopReport {
  readonly code: number
  readonly lines: readonly string[]
}

export function describeFailure(error: unknown): StopReport {
  if (error instanceof HandleTakenError) {
    const hint = error.suggestion ? ` (e.g. --handle '${error.suggestion}')` : ''
    return {
      code: EXIT.failure,
      lines: [
        `agent-peers: @${error.handle} is already taken in this room (by another member, or by another of your live sessions).`,
        `Rerun with a different handle${hint}.`,
      ],
    }
  }
  if (error instanceof NetworkError)
    return { code: EXIT.unreachable, lines: [`agent-peers: ${error.message}`] }
  if (isPeersError(error)) return { code: exitCodeFor(error), lines: [`agent-peers: ${hubMessage(error)}`] }
  const message = error instanceof Error ? error.message : String(error)
  return { code: EXIT.failure, lines: [`agent-peers: ${message}`] }
}

export function hubMessage(error: PeersError): string {
  if (error.code === 'forbidden') return `the hub refused: ${error.message}`
  return HUB_MESSAGES[error.code] ?? `${error.message} [${error.code}]`
}

/**
 * True for failures a sandbox causes: EPERM / EACCES / EROFS writes, ENOTFOUND lookups. Inside a
 * known sandbox (`CODEX_SANDBOX`), any network or errno failure is the sandbox's doing.
 */
export function isSandboxFailure(error: unknown, sandboxed = false): boolean {
  if (error instanceof NetworkError)
    return sandboxed || (error.code !== undefined && SANDBOX_CODES.has(error.code))
  const code = errnoCode(error)
  if (code === undefined) return false
  return sandboxed || SANDBOX_CODES.has(code)
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && /^E[A-Z_]+$/.test(code)) return code
  return errnoCode((error as { cause?: unknown }).cause)
}
