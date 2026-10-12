/** The v0 agent registry (ARCHITECTURE §1 "v0 decided"): one detector per target. */
import { detectClaudeCode, detectClaudeDesktop } from './claude'
import { detectCodex, detectCodexDesktop } from './codex'
import { AGENT_IDS, type AgentDetection, type AgentId, type Sys } from './types'

export interface AgentEntry {
  readonly id: AgentId
  readonly label: string
  /** The `--surface` the bridge runs with for this agent. */
  readonly surface: 'claude-code' | 'claude-desktop' | 'codex'
  detect(sys: Sys): Promise<AgentDetection>
}

export const AGENTS: Readonly<Record<AgentId, AgentEntry>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    surface: 'claude-code',
    detect: detectClaudeCode,
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    surface: 'claude-desktop',
    detect: detectClaudeDesktop,
  },
  codex: { id: 'codex', label: 'Codex CLI', surface: 'codex', detect: detectCodex },
  'codex-desktop': {
    id: 'codex-desktop',
    label: 'Codex desktop',
    surface: 'codex',
    detect: detectCodexDesktop,
  },
}

/** Detects every v0 agent (in registry order). */
export async function detectAll(sys: Sys): Promise<readonly AgentDetection[]> {
  return Promise.all(AGENT_IDS.map((id) => AGENTS[id].detect(sys)))
}
