/** Pure policy helpers: the peer-turn budget (ARCHITECTURE §8) and the reply fallback (PROTOCOL §7.3). */
import type { ReplyFallback } from '../config/schemas'
import type { FallbackReply, PeerTurn } from './types'

export const BUDGET_WINDOW_MS = 60 * 60 * 1000

/** Drops start times older than the window. */
export function pruneStarts(
  starts: readonly number[],
  now: number,
  windowMs = BUDGET_WINDOW_MS,
): readonly number[] {
  return starts.filter((at) => at > now - windowMs)
}

/** True when another peer turn may start now. */
export function withinBudget(
  starts: readonly number[],
  now: number,
  perHour: number,
  windowMs = BUDGET_WINDOW_MS,
): boolean {
  return pruneStarts(starts, now, windowMs).length < perHour
}

/** When the oldest start leaves the window (the next free slot), or undefined if not exhausted. */
export function budgetResetsAt(
  starts: readonly number[],
  now: number,
  perHour: number,
  windowMs = BUDGET_WINDOW_MS,
): number | undefined {
  const live = [...pruneStarts(starts, now, windowMs)].sort((a, b) => a - b)
  if (live.length < perHour) return undefined
  const index = live.length - perHour
  return (live[index] as number) + windowMs
}

export const NO_REPLY_TEXT = 'no reply'

export interface FallbackInput {
  readonly turn: PeerTurn
  readonly ask_id: string
  /** The turn's final assistant message, when the adapter can see it. */
  readonly last_message?: string
  readonly reply_fallback: ReplyFallback
}

/**
 * PROTOCOL §7.3 step 2/3: send the final message as the reply only when the turn was started solely
 * by this one ask (a wake injection), the final message is visible, and `reply_fallback` is `auto`.
 * Otherwise the ask fails with "no reply".
 */
export function decideReplyFallback(input: FallbackInput): FallbackReply {
  const { turn, ask_id } = input
  const text = input.last_message?.trim() ?? ''
  const sole = turn.started_by === 'wake' && turn.ask_ids.length === 1 && turn.ask_ids[0] === ask_id
  if (sole && text.length > 0 && input.reply_fallback === 'auto')
    return { ask_id, state: 'answered', text, auto: true }
  return { ask_id, state: 'failed', text: NO_REPLY_TEXT, auto: false }
}

/** The step-1 reminder: continue the agent once, asking it to reply. */
export function replyReminder(askIds: readonly string[]): string {
  const list = askIds.join(', ')
  const plural = askIds.length > 1
  return (
    `[agent-peers] You have not replied to the peer ask${plural ? 's' : ''} ${list}. ` +
    `Call peers_reply(ask_id, text) now${plural ? ' for each' : ''}, ` +
    'or reply with state "declined" if you will not answer.'
  )
}
