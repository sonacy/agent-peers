/**
 * Step 7 of `join` (ONBOARDING §3, §4): the roster (handle · agent · connection, no free text), the
 * commands in this agent's syntax, and the `[agent-peers] FINISH:` block, always the CLI's own text
 * and never hub text. When the adapter is already installed, the CLI first asks every local bridge
 * to auto-join now; if exactly one accepts there is nothing left to do.
 */
import { broadcastToBridges, listBridges, type ProcessTree } from '@agent-peers/core'
import type { AgentKind, DeepReadonly, MemberEntry } from '@agent-peers/protocol'
import { AGENTS } from '../agents/registry'
import { type AgentId, isAgentId } from '../agents/types'
import { FINISH_HEADER } from '../commands/add'
import { installerFor } from '../install/index'

/** ONBOARDING §4 for agents without a v0 installer (their text cannot come from an installer). */
const OTHER_FINISH: Readonly<Partial<Record<AgentKind, string>>> = {
  cursor: 'run "Developer: Reload Window", then send any message in this chat',
  pi: 'type /reload',
  opencode: 'restart opencode (opencode -c)',
}

export const NO_AGENT_FINISH =
  'install agent-peers into your coding agent (agent-peers add), then do the finishing step it prints'

/** ARCHITECTURE §3.2: how the user types `ask` / `who` in each agent. */
const COMMAND_SYNTAX: Readonly<Partial<Record<AgentKind, readonly [string, string]>>> = {
  'claude-code': ['/peers:ask', '/peers:who'],
  codex: ['$peers:ask', '$peers:who'],
  'codex-desktop': ['$peers:ask', '$peers:who'],
  pi: ['/peers:ask', '/peers:who'],
  cursor: ['/peers-ask', '/peers-who'],
  opencode: ['/peers/ask', '/peers/who'],
}

export function rosterLines(members: readonly DeepReadonly<MemberEntry>[], self: string): readonly string[] {
  if (members.length === 0) return ['nobody is here yet']
  return members.map((m) =>
    m.handle === self
      ? `@${m.handle} · ${m.card.agent.kind} · you (reserved; live after the finishing step)`
      : `@${m.handle} · ${m.card.agent.kind} · ${m.card.connection}`,
  )
}

export function commandLines(kind: AgentKind, target: string): readonly string[] {
  const shell = `shell fallback: agent-peers ask @${target} "<question>" · agent-peers who`
  const syntax = COMMAND_SYNTAX[kind]
  if (syntax) return [`ask: ${syntax[0]} @${target} <question> · who: ${syntax[1]}`, shell]
  if (kind === 'claude-desktop') return [`ask: say "ask @${target} <question>" in a chat`, shell]
  return [shell]
}

export function finishText(kind: AgentKind, method: string | undefined): string {
  if (isAgentId(kind)) return installerFor(kind).finish(method)
  return OTHER_FINISH[kind] ?? NO_AGENT_FINISH
}

/** The final block: one line per agent, or the "nothing to do" line when the session is live. */
export function finishBlock(
  ids: readonly AgentId[],
  methods: Readonly<Partial<Record<AgentId, string>>>,
  live: string | undefined,
): readonly string[] {
  if (live !== undefined) return ['', FINISH_HEADER, `  nothing to do: ${live}`]
  if (ids.length === 0) return ['', FINISH_HEADER, `  ${NO_AGENT_FINISH}`]
  return ['', FINISH_HEADER, ...ids.map((id) => `  ${AGENTS[id].label}: ${finishText(id, methods[id])}`)]
}

export interface LiveAutojoinRequest {
  readonly runDir: string
  readonly tree?: ProcessTree
  readonly localKey: string
  readonly agentKind: AgentKind
  readonly workspace: string
  readonly timeoutMs?: number
}

/** `autojoin` to every local bridge; true only when exactly one accepted (ONBOARDING §4). */
export async function tryLiveAutojoin(request: LiveAutojoinRequest): Promise<boolean> {
  const bridges = await listBridges(request.runDir, request.tree)
  if (bridges.length === 0) return false
  const results = await broadcastToBridges(
    bridges,
    'autojoin',
    { local_key: request.localKey, agent_kind: request.agentKind, workspace: request.workspace },
    { timeoutMs: request.timeoutMs ?? 5_000 },
  )
  return results.filter((r) => r.ok && r.result.accepted).length === 1
}

/** v0: the no-reload path is enabled for Claude Code only (ONBOARDING §4). */
export const LIVE_AUTOJOIN_KINDS: ReadonlySet<AgentKind> = new Set(['claude-code'])
