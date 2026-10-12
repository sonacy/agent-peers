/**
 * Surface verification at MCP `initialize` (ARCHITECTURE §6.2): the bridge checks `clientInfo` and its
 * environment against the surface it was installed for. On a mismatch (Claude Desktop's config loaded
 * into the Desktop Code tab, a Claude plugin imported by Cursor, an unknown client) it stays inert:
 * no tools, no hub connection, no control socket.
 */
import type { EnvLike } from '@agent-peers/core'
import { type BridgeSurface, surfaceFamily } from './surfaces'

export interface ClientIdentity {
  readonly name?: string
  readonly title?: string
  readonly version?: string
}

export type ClientFamily = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'unknown'

export interface SurfaceVerdict {
  readonly ok: boolean
  /** The surface actually served (`codex` may resolve to `codex-desktop`). */
  readonly surface: BridgeSurface
  readonly client: ClientFamily
  readonly reason: string
}

export type SurfaceCheck = 'strict' | 'off'

/** Escape hatch for `doctor` and manual debugging: `AGENT_PEERS_SURFACE_CHECK=off`. */
export const SURFACE_CHECK_ENV = 'AGENT_PEERS_SURFACE_CHECK'

/** Family of the MCP client from `clientInfo` (Claude Code `claude-code`, Desktop `claude-ai`, Codex `codex-mcp-client`). */
export function clientFamily(info: ClientIdentity | undefined): ClientFamily {
  const label = `${info?.name ?? ''} ${info?.title ?? ''}`.toLowerCase()
  if (label.includes('cursor')) return 'cursor'
  if (/claude[-_ ]?code/.test(label)) return 'claude-code'
  if (/claude[-_ ]?(ai|desktop)/.test(label)) return 'claude-desktop'
  if (label.includes('codex')) return 'codex'
  return 'unknown'
}

const has = (env: EnvLike, key: string): boolean => (env[key] ?? '').trim().length > 0

/** Family suggested by the spawn environment, when it carries a recognizable marker. */
export function envFamily(env: EnvLike): ClientFamily {
  if (has(env, 'CURSOR_VERSION') || has(env, 'CURSOR_AGENT') || has(env, 'CURSOR_TRACE_ID')) return 'cursor'
  if (env.CLAUDECODE === '1' || has(env, 'CLAUDE_CODE_SESSION_ID') || has(env, 'CLAUDE_CODE_ENTRYPOINT'))
    return 'claude-code'
  if (has(env, 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE') || has(env, 'CODEX_THREAD_ID')) return 'codex'
  return 'unknown'
}

/** Codex desktop (ChatGPT.app) runs the same plugin tree as the CLI; tell them apart at runtime. */
export function isCodexDesktop(info: ClientIdentity | undefined, env: EnvLike): boolean {
  const originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? ''
  const label = `${info?.name ?? ''} ${info?.title ?? ''}`
  return (
    /desktop|chatgpt/i.test(originator) ||
    env.__CFBundleIdentifier === 'com.openai.codex' ||
    /desktop|chatgpt/i.test(label)
  )
}

function resolveSurface(requested: BridgeSurface, info: ClientIdentity | undefined, env: EnvLike) {
  if (requested === 'codex' && isCodexDesktop(info, env)) return 'codex-desktop'
  return requested
}

const reject = (surface: BridgeSurface, client: ClientFamily, reason: string): SurfaceVerdict => ({
  ok: false,
  surface,
  client,
  reason,
})

function mismatch(requested: BridgeSurface, client: ClientFamily, fromEnv: ClientFamily): string | undefined {
  const expected = surfaceFamily(requested)
  if (client === 'cursor' || fromEnv === 'cursor')
    return `loaded by Cursor, but this bridge serves ${requested}; Cursor uses its own agent-peers adapter`
  if (client !== 'unknown' && client !== expected)
    return `loaded by ${client}, but this bridge was installed for ${requested}`
  if (client === 'unknown' && fromEnv !== expected)
    return `unrecognized MCP client; this bridge was installed for ${requested}`
  if (requested === 'claude-desktop' && fromEnv === 'claude-code')
    return 'running inside Claude Code (the Desktop Code tab loads claude_desktop_config.json too)'
  return undefined
}

export function verifySurface(input: {
  readonly requested: BridgeSurface
  readonly client: ClientIdentity | undefined
  readonly env: EnvLike
  readonly mode?: SurfaceCheck
}): SurfaceVerdict {
  const { requested, env } = input
  const client = clientFamily(input.client)
  const surface = resolveSurface(requested, input.client, env)
  const mode = env[SURFACE_CHECK_ENV] === 'off' ? 'off' : (input.mode ?? 'strict')
  if (mode === 'off') return { ok: true, surface, client, reason: 'surface check disabled' }
  const problem = mismatch(requested, client, envFamily(env))
  if (problem) return reject(surface, client, problem)
  return { ok: true, surface, client, reason: `verified ${surface}` }
}
