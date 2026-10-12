/** AgentChip (DASHBOARD §4.3): face, truncated title, `{status} · {tool}`, and ⇥ 移出房间. */
import { ArrowRightToLine } from 'lucide-react'
import type { RoomAgent } from '../../../api/types'
import { agentKindLabel, agentStatus } from '../../../lib/agent'
import { AgentFace } from '../../agent-face'
import { Status } from '../../status'
import { TruncatedText } from '../../truncated-text'
import { agentTitle } from '../model/people-model'

export interface AgentChipProps {
  readonly agent: RoomAgent
  /** Shown on my own agents, and to the owner on everyone's. */
  readonly onRemove?: (agent: RoomAgent) => void
}

export function AgentChip({ agent, onRemove }: AgentChipProps) {
  const title = agentTitle(agent)
  const status = agentStatus(agent.card)
  return (
    <li
      aria-label={title}
      data-session-id={agent.card.session_id}
      className="flex min-w-0 items-center gap-2.5 rounded-xl border-2 border-line bg-surface py-2 pr-1 pl-2.5 shadow-chip"
    >
      <AgentFace id={agent.card.session_id} size={28} expression={status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TruncatedText text={title} tooltip className="font-semibold text-sm" />
        <span className="flex min-w-0 items-center gap-1 text-meta">
          <Status status={status} className="shrink-0" />
          <span className="shrink-0 whitespace-nowrap text-muted">
            · {agentKindLabel(agent.card.agent.kind)}
          </span>
        </span>
      </div>
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={`把 ${title} 移出房间`}
          title="移出房间"
          onClick={() => onRemove(agent)}
          className="focus-ring inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ArrowRightToLine aria-hidden="true" className="size-4" />
        </button>
      )}
    </li>
  )
}
