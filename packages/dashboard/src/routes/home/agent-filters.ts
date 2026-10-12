/** 我的 agent filter chips (DASHBOARD §4.1): 全部 · 有空 · 正在忙 · 离线. */
import type { SessionCard } from '../../api/types'
import { type AgentStatus, agentStatus } from '../../lib/agent'

export const AGENT_FILTERS = ['all', 'idle', 'busy', 'offline'] as const
export type AgentFilter = (typeof AGENT_FILTERS)[number]

export const FILTER_LABEL: Readonly<Record<AgentFilter, string>> = {
  all: '全部',
  idle: '有空',
  busy: '正在忙',
  offline: '离线',
}

/** `awaiting` (等你确认) counts as busy: the agent is mid-turn. */
export function filterOf(status: AgentStatus): Exclude<AgentFilter, 'all'> {
  return status === 'awaiting' ? 'busy' : status
}

export function matchesFilter(card: SessionCard, filter: AgentFilter): boolean {
  return filter === 'all' || filterOf(agentStatus(card)) === filter
}

export function filterCounts(cards: readonly SessionCard[]): Readonly<Record<AgentFilter, number>> {
  const count = (key: Exclude<AgentFilter, 'all'>) =>
    cards.filter((card) => filterOf(agentStatus(card)) === key).length
  return { all: cards.length, idle: count('idle'), busy: count('busy'), offline: count('offline') }
}
