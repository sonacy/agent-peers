/** Agent display rules: tool labels, status (§3) and reachability copy (§6). */
import type { AgentKind, SessionCard } from '@agent-peers/protocol'

const KIND_LABEL: Readonly<Record<AgentKind, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  'codex-desktop': 'Codex Desktop',
  cursor: 'Cursor',
  'cursor-cli': 'Cursor CLI',
  pi: 'Pi',
  opencode: 'OpenCode',
  trae: 'Trae IDE',
  'trae-cli': 'Trae CLI',
  other: 'Agent',
}

export function agentKindLabel(kind: AgentKind): string {
  return KIND_LABEL[kind]
}

export const AGENT_STATUSES = ['idle', 'busy', 'offline', 'awaiting'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const STATUS_LABEL: Readonly<Record<AgentStatus, string>> = {
  idle: '有空',
  busy: '正在忙',
  offline: '离线',
  awaiting: '等你确认',
}

type StatusFields = Pick<SessionCard, 'connection' | 'activity'>

/** Offline wins over activity; `stale` connections still count as present. */
export function agentStatus(card: StatusFields): AgentStatus {
  if (card.connection === 'offline') return 'offline'
  if (card.activity === 'busy') return 'busy'
  if (card.activity === 'awaiting_input') return 'awaiting'
  return 'idle'
}

type ReachFields = Pick<SessionCard, 'inject' | 'accepting'> & {
  readonly agent: { readonly kind: AgentKind }
}

const CODEX_KINDS: ReadonlySet<AgentKind> = new Set(['codex', 'codex-desktop'])

/**
 * §6 boundary copy. Codex reports boundary until its first `codex queue` push works, Claude Code
 * while no asyncRewake waiter is armed (it re-arms at the next Stop); neither has a time window.
 * Cursor and Trae wait at the end of a turn for up to 60 minutes.
 */
function boundaryHint(kind: AgentKind): string {
  const label = agentKindLabel(kind)
  if (CODEX_KINDS.has(kind))
    return `${label} 会在当前或下一轮开始、结束时收到问题，推送成功一次后就能自己醒来`
  if (kind === 'claude-code')
    return `${label} 会在当前或下一轮开始、结束时收到问题，下一轮结束后就又能自己醒来`
  return `${label} 一轮结束后 60 分钟内能被问到，超过要你在对话里说句话唤醒它`
}

/**
 * §6 reachability hint, or undefined for push-tier agents. A Codex session reporting `poll` means
 * its hooks aren't trusted yet (it would be push otherwise).
 */
export function reachabilityHint(card: ReachFields): string | undefined {
  if (!card.accepting) return '已暂停接受提问'
  const kind = card.agent.kind
  if (card.inject === 'boundary') return boundaryHint(kind)
  if (card.inject !== 'poll') return undefined
  if (CODEX_KINDS.has(kind)) return '还没在 /hooks 里信任 peers，问题只能等你下次说话'
  return `${agentKindLabel(kind)} 不能自己醒来，你下次在这个对话里说话时它才会看到问题`
}

/** §5 outdated-plugin copy on an agent card. The card doesn't carry `min_adapter`, so it is optional. */
export function outdatedPluginText(version: string, minVersion?: string): string {
  const need = minVersion === undefined ? '更新的版本' : `${minVersion} 以上`
  return `这个 agent 的 Peers 插件是 ${version}，Core 要${minVersion === undefined ? '' : ' '}${need}。升级后完全退出再打开这个 agent。`
}

/** §5 boundary-tier reminder when an ask waits past the 60-minute window. */
export function boundaryReminderText(kind: AgentKind, pending: number): string {
  return `它有 ${pending} 个问题等着答，但已经过了 60 分钟窗口。在 ${agentKindLabel(kind)} 的这个对话里随便发句话，这一轮结束后它就会开始答。`
}
