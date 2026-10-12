/**
 * QAThread (DASHBOARD §4.4): asker → target header with room chip and time, the question in a grey
 * bubble on the left, the answer (or its state) on the right. `compact` is the 刚刚聊过 layout.
 */
import type { SessionCard } from '@agent-peers/protocol'
import { ArrowRight, House } from 'lucide-react'
import type { AskThread } from '../../api/types'
import { agentStatus } from '../../lib/agent'
import { cn } from '../../lib/cn'
import { AgentFace } from '../agent-face'
import { RelativeTime } from '../relative-time'
import { TruncatedText } from '../truncated-text'
import { Card } from '../ui/card'
import { Chip } from '../ui/chip'
import { AnswerArea } from './answer-state'
import { InlineText, MessageBody } from './message-text'

export interface Party {
  readonly faceId: string
  readonly name: string
  readonly member: string
  readonly card: SessionCard | undefined
}

/** Who is on one side of an ask: the session card when known, else the handle in the room. */
export function partyOf(
  card: SessionCard | null | undefined,
  handle: string,
  member: string,
  roomId: string,
): Party {
  if (card) return { faceId: card.session_id, name: card.title ?? `@${handle}`, member: card.member, card }
  return { faceId: `${roomId}:${handle}`, name: `@${handle}`, member, card: undefined }
}

export function threadParties(thread: AskThread): { readonly from: Party; readonly to: Party } {
  const { ask } = thread
  return {
    from: partyOf(thread.from, ask.from_handle, ask.from_member, ask.room_id),
    to: partyOf(thread.to, ask.to_handle, thread.to?.member ?? '', ask.room_id),
  }
}

/** Faces in the header are the 28px chip size, so status expressions stay readable (22 is for stacks). */
const HEADER_FACE = 28

function PartyLabel({ party, me }: { readonly party: Party; readonly me?: string }) {
  const other = me !== undefined && party.member !== '' && party.member !== me
  const label = other ? `${party.name} · ${party.member}` : party.name
  return (
    <span className="inline-flex min-w-0 max-w-1/2 items-center gap-2">
      <AgentFace
        id={party.faceId}
        size={HEADER_FACE}
        expression={party.card ? agentStatus(party.card) : 'idle'}
      />
      <TruncatedText text={label} tooltip className="font-semibold text-sm" />
    </span>
  )
}

export interface QAThreadProps {
  readonly thread: AskThread
  /** My member name: parties from other members get `· {member}`. */
  readonly me?: string
  /** The room's display name (`支付联调`); defaults to its slug. */
  readonly roomTitle?: string
  readonly compact?: boolean
  readonly className?: string
}

/**
 * Asker → target, each up to half the row. Below 640px the room chip and time move to their own
 * meta row above the participants, so names keep their room.
 */
function Header({ thread, me, roomTitle, compact }: Omit<QAThreadProps, 'className'>) {
  const { from, to } = threadParties(thread)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PartyLabel party={from} me={me} />
        <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <span className="sr-only">问</span>
        <PartyLabel party={to} me={me} />
      </div>
      {compact ? null : (
        <div className="order-first flex min-w-0 shrink-0 items-center gap-2 text-meta text-muted sm:order-none">
          <Chip tone="violet" className="min-w-0" title={roomTitle ?? thread.room.name}>
            <House aria-hidden="true" />
            <span className="truncate">{roomTitle ?? thread.room.name}</span>
          </Chip>
          <RelativeTime ts={thread.question.ts} />
        </div>
      )}
    </div>
  )
}

export function QAThread({ thread, me, roomTitle, compact = false, className }: QAThreadProps) {
  return (
    <Card
      data-ask-id={thread.ask.ask_id}
      className={cn('flex min-w-0 flex-col gap-3', compact ? 'p-4' : 'p-4 sm:p-5', className)}
      role="article"
      aria-label={`问答：${thread.question.text.slice(0, 40)}`}
    >
      <Header thread={thread} me={me} roomTitle={roomTitle} compact={compact} />
      <div className="max-w-[92%] self-start rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2.5 text-sm">
        {compact ? (
          <p className="line-clamp-2 break-words">
            <InlineText text={thread.question.text} />
          </p>
        ) : (
          <MessageBody text={thread.question.text} />
        )}
      </div>
      <AnswerArea thread={thread} compact={compact} />
    </Card>
  )
}
