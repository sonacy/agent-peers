/** The answer side of a Q&A thread (DASHBOARD §4.4): a lime bubble, or what's happening instead. */
import type { AskState } from '@agent-peers/protocol'
import { Check } from 'lucide-react'
import type { AskThread } from '../../api/types'
import { cn } from '../../lib/cn'
import { failReasonText } from '../../lib/format/reasons'
import { CollapsibleMessage, InlineText } from './message-text'

/** The note shown for an ask that has no answer bubble; undefined for `answered`. */
export function answerNote(thread: Pick<AskThread, 'ask' | 'answer'>): string | undefined {
  const { ask, answer } = thread
  switch (ask.state) {
    case 'answered':
      return answer ? undefined : '已经答了，答案马上到'
    case 'working':
      return '已送到，对方正在想，答完会自己回到你的对话'
    case 'queued':
      return '对方不在线，上线后会收到'
    case 'delivered':
      return '已送到，对方空下来就答'
    case 'declined':
      return `对方没接这个问题：${failReasonText('declined', answer?.text)}`
    case 'failed':
    case 'expired':
      return `⊘ 没答上：${failReasonText(ask.reason ?? (ask.state === 'expired' ? 'expired' : undefined), answer?.text)}`
    case 'cancelled':
      return '提问的一方撤回了这个问题'
  }
}

const NOTE_TONE: Readonly<Partial<Record<AskState, string>>> = {
  declined: 'bg-warn text-warn-ink',
  failed: 'bg-surface-2 text-muted',
  expired: 'bg-surface-2 text-muted',
}

/** Staggered dots, spelled out so the class scanner sees them (no inline styles under the CSP). */
const DOT_DELAYS = ['[animation-delay:0ms]', '[animation-delay:160ms]', '[animation-delay:320ms]'] as const

export function TypingDots({ className }: { readonly className?: string }) {
  return (
    <span aria-hidden="true" data-typing="true" className={cn('inline-flex items-center gap-1', className)}>
      {DOT_DELAYS.map((delay) => (
        <span key={delay} className={cn('size-1.5 rounded-full bg-current animate-typing', delay)} />
      ))}
    </span>
  )
}

export function AnswerBubble({
  text,
  compact = false,
}: {
  readonly text: string
  readonly compact?: boolean
}) {
  return (
    <div
      className={cn(
        'max-w-[92%] self-end rounded-2xl rounded-br-md border-2 border-line bg-lime px-3.5 py-2.5 text-lime-ink text-sm shadow-chip',
        compact && 'max-w-full',
      )}
    >
      {compact ? (
        <p className="line-clamp-2 break-words">
          <InlineText text={text} />
        </p>
      ) : (
        <CollapsibleMessage text={text} />
      )}
    </div>
  )
}

/** 刚刚聊过: the status sits right under the question, typing dots inline, one line. */
function CompactNote({ state, note }: { readonly state: AskState; readonly note: string | undefined }) {
  return (
    <p
      data-ask-state={state}
      className={cn(
        'flex min-w-0 items-center gap-2 self-start rounded-xl text-meta',
        NOTE_TONE[state] === undefined ? 'px-1 text-muted' : cn('px-3 py-1.5', NOTE_TONE[state]),
      )}
    >
      {state === 'working' ? <TypingDots className="shrink-0" /> : null}
      <span className="line-clamp-1">{note}</span>
    </p>
  )
}

export function AnswerArea({
  thread,
  compact = false,
}: {
  readonly thread: AskThread
  readonly compact?: boolean
}) {
  const note = answerNote(thread)
  if (note === undefined && thread.answer) {
    return (
      <div className="flex flex-col items-end gap-1">
        <AnswerBubble text={thread.answer.text} compact={compact} />
        {compact ? null : (
          <span className="inline-flex items-center gap-1 text-meta text-muted">
            <Check aria-hidden="true" className="size-3.5" />
            已回答
          </span>
        )}
      </div>
    )
  }
  const state = thread.ask.state
  const working = state === 'working'
  if (compact) return <CompactNote state={state} note={note} />
  return (
    <div className="flex flex-col items-end gap-1.5" data-ask-state={state}>
      {working ? (
        <span className="inline-flex h-8 items-center rounded-full border-[1.5px] border-line/20 bg-surface-2 px-3 text-muted">
          <TypingDots />
        </span>
      ) : null}
      <p
        className={cn(
          'max-w-full rounded-xl px-3 py-1.5 text-right text-meta',
          NOTE_TONE[state] ?? 'text-muted',
        )}
      >
        {note}
      </p>
    </div>
  )
}
