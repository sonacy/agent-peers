/**
 * What each simulated agent looks like to the bridge it spawns (verified research, ARCHITECTURE §6):
 * the MCP `clientInfo`, the spawn environment, and the per-call `_meta`.
 * - Claude Code: clientInfo `claude-code`; env CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_PROJECT_DIR.
 * - Claude Desktop: clientInfo `claude-ai`; no session id, no hooks.
 * - Codex CLI / desktop: clientInfo `codex-mcp-client` and `_meta["x-codex-turn-metadata"]` on every
 *   tools/call. Both run the same plugin (`--surface codex`); the desktop app's app-server sets
 *   CODEX_INTERNAL_ORIGINATOR_OVERRIDE and CODEX_CLI_PATH (its bundled engine), and its bundle id.
 */
import type { Machine } from './machine'

export type Surface = 'claude-code' | 'claude-desktop' | 'codex' | 'codex-desktop'

export const SURFACES: readonly Surface[] = ['claude-code', 'claude-desktop', 'codex', 'codex-desktop']

export interface SurfaceProfile {
  readonly cliSurface: string
  readonly clientInfo: { readonly name: string; readonly version: string; readonly title?: string }
  /** The agent kind the hub shows on the card. */
  readonly agentKind: string
  env(machine: Machine, sessionKey: string | undefined): Readonly<Record<string, string>>
  meta(thread: string | undefined): Readonly<Record<string, unknown>> | undefined
}

const codexMeta = (thread: string | undefined) =>
  thread === undefined
    ? undefined
    : {
        'x-codex-turn-metadata': { session_id: thread, thread_id: thread, turn_id: `turn-${Date.now()}` },
      }

const CODEX_CLIENT = { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' }

const PROFILES: Readonly<Record<Surface, SurfaceProfile>> = {
  'claude-code': {
    cliSurface: 'claude-code',
    clientInfo: { name: 'claude-code', version: '2.1.296' },
    agentKind: 'claude-code',
    env: (machine, key) => ({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PROJECT_DIR: machine.workspace,
      ...(key === undefined ? {} : { CLAUDE_CODE_SESSION_ID: key }),
    }),
    meta: () => undefined,
  },
  'claude-desktop': {
    cliSurface: 'claude-desktop',
    clientInfo: { name: 'claude-ai', version: '0.14.10' },
    agentKind: 'claude-desktop',
    env: () => ({}),
    meta: () => undefined,
  },
  codex: {
    cliSurface: 'codex',
    clientInfo: CODEX_CLIENT,
    agentKind: 'codex',
    env: (machine) => ({ CODEX_CLI_PATH: machine.codexPath }),
    meta: codexMeta,
  },
  'codex-desktop': {
    cliSurface: 'codex',
    clientInfo: CODEX_CLIENT,
    agentKind: 'codex-desktop',
    env: (machine) => ({
      CODEX_CLI_PATH: machine.codexPath,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      __CFBundleIdentifier: 'com.openai.codex',
    }),
    meta: codexMeta,
  },
}

export const profileFor = (surface: Surface): SurfaceProfile => PROFILES[surface]
