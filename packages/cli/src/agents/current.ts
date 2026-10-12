/**
 * Which agent is running this CLI (`add --here`, `join --here`; ONBOARDING §3 step 2). The agents'
 * own env vars are checked first (they also carry the session key and the running binary), then
 * `@vercel/detect-agent` for everything else.
 */
import type { EnvLike } from '@agent-peers/core'
import type { AgentId } from './types'

export interface CurrentAgent {
  /** The agent's name as detected (`claude`, `codex`, `cursor`, …). */
  readonly name: string
  /** The v0 target it maps to; undefined for agents agent-peers does not support yet. */
  readonly id?: AgentId
  /** CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID. */
  readonly sessionKey?: string
  /** The binary of the running agent, when the agent exports it (CLAUDE_CODE_EXECPATH). */
  readonly runningBinary?: string
  /** True inside the Codex sandbox (writes outside the workspace and the network may fail). */
  readonly sandboxed: boolean
}

/** The `@vercel/detect-agent` result shape (its `determineAgent` reads `process.env`). */
export interface DetectedAgentResult {
  readonly isAgent: boolean
  readonly agent?: { readonly name: string }
}
export type DetermineAgent = () => Promise<DetectedAgentResult>

const value = (env: EnvLike, key: string): string | undefined => {
  const text = env[key]?.trim()
  return text ? text : undefined
}

/** The Codex desktop app runs its engine with CODEX_CLI_PATH into the app bundle. */
function isCodexDesktop(env: EnvLike): boolean {
  const originator = value(env, 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE') ?? ''
  const cliPath = value(env, 'CODEX_CLI_PATH') ?? ''
  return /desktop/i.test(originator) || /\.app[/\\]/.test(cliPath)
}

function fromEnv(env: EnvLike): CurrentAgent | undefined {
  const sandboxed = value(env, 'CODEX_SANDBOX') !== undefined
  if (value(env, 'CODEX_THREAD_ID') || sandboxed || value(env, 'CODEX_CI')) {
    const sessionKey = value(env, 'CODEX_THREAD_ID')
    return {
      name: 'codex',
      id: isCodexDesktop(env) ? 'codex-desktop' : 'codex',
      sandboxed,
      ...(sessionKey ? { sessionKey } : {}),
    }
  }
  if (value(env, 'CLAUDECODE') || value(env, 'CLAUDE_CODE')) {
    if (value(env, 'CLAUDE_CODE_IS_COWORK')) return { name: 'cowork', sandboxed }
    const sessionKey = value(env, 'CLAUDE_CODE_SESSION_ID')
    const runningBinary = value(env, 'CLAUDE_CODE_EXECPATH')
    return {
      name: 'claude',
      id: 'claude-code',
      sandboxed,
      ...(sessionKey ? { sessionKey } : {}),
      ...(runningBinary ? { runningBinary } : {}),
    }
  }
  return undefined
}

const DETECTED_NAME_TO_ID: Readonly<Record<string, AgentId>> = { claude: 'claude-code', codex: 'codex' }

/** The agent running this process, or undefined in a plain terminal. */
export async function detectCurrentAgent(
  env: EnvLike,
  determine?: DetermineAgent,
): Promise<CurrentAgent | undefined> {
  const direct = fromEnv(env)
  if (direct) return direct
  if (!determine) return undefined
  const result = await determine()
  const name = result.isAgent ? result.agent?.name : undefined
  if (!name) return undefined
  const id = DETECTED_NAME_TO_ID[name]
  return { name, sandboxed: false, ...(id ? { id } : {}) }
}
