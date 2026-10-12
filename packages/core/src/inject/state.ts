/**
 * Pure reducers for one session's injection queue. Every function returns a new state and never
 * mutates its input. Times come from the caller.
 */
import type { ReplyFallback } from '../config/schemas'
import { decideReplyFallback, pruneStarts, replyReminder, withinBudget } from './policy'
import type {
  DropReason,
  InjectChannel,
  InjectMessage,
  ItemState,
  PeerTurn,
  QueueItem,
  QueueState,
  TurnEndOutcome,
} from './types'

const INJECTABLE: ReadonlySet<string> = new Set(['ask', 'reply'])

function patchItem<M extends InjectMessage>(
  state: QueueState<M>,
  id: string,
  patch: (item: QueueItem<M>) => QueueItem<M>,
): QueueState<M> {
  return { ...state, items: state.items.map((item) => (item.id === id ? patch(item) : item)) }
}

/** Drops the hand-out fields and moves the item to `state`. */
function unlease<M extends InjectMessage>(item: QueueItem<M>, state: ItemState): QueueItem<M> {
  const { inject_id: _i, channel: _c, lease_until: _l, ...rest } = item
  return { ...rest, state }
}

export const askIdOf = (item: QueueItem): string => item.message.id

export interface EnqueueOptions {
  readonly now: number
  /** Replayed by the hub after reconnect/claim. */
  readonly replay?: boolean
  /** Replayed asks older than this go to the inbox. */
  readonly maxReplayAgeMs?: number
}

/** Adds a message. Duplicates (same id) are ignored; non-injectable kinds become `inbox_only`. */
export function enqueue<M extends InjectMessage>(
  state: QueueState<M>,
  message: M,
  options: EnqueueOptions,
): QueueState<M> {
  if (state.items.some((item) => item.id === message.id)) return state
  const kind = message.kind === 'ask' ? 'ask' : 'reply'
  const base: QueueItem<M> = {
    id: message.id,
    message,
    kind,
    state: 'pending',
    enqueued_at: options.now,
    claimed: false,
  }
  const stale =
    options.replay === true &&
    options.maxReplayAgeMs !== undefined &&
    message.ts !== undefined &&
    options.now - message.ts > options.maxReplayAgeMs
  const item: QueueItem<M> = !INJECTABLE.has(message.kind)
    ? { ...base, state: 'inbox_only', reason: 'not_injectable' }
    : stale
      ? { ...base, state: 'inbox_only', reason: 'stale_replay' }
      : base
  return { ...state, items: [...state.items, item] }
}

/** Removes `inject_id`'s ask from the peer turn; clears the turn when nothing is left in it. */
function leaveTurn(turn: PeerTurn | null, item: QueueItem): PeerTurn | null {
  if (!turn || item.inject_id === undefined || !turn.inject_ids.includes(item.inject_id)) return turn
  const inject_ids = turn.inject_ids.filter((id) => id !== item.inject_id)
  const ask_ids = item.kind === 'ask' ? turn.ask_ids.filter((id) => id !== askIdOf(item)) : turn.ask_ids
  return ask_ids.length === 0 ? null : { ...turn, inject_ids, ask_ids }
}

/**
 * Puts handed-out items whose lease ran out back to pending (claim kept). The peer turn is left as
 * it is: the agent may have seen the envelope, so its gate must not lift (a re-hand-out rejoins it).
 */
export function expireLeases<M extends InjectMessage>(state: QueueState<M>, now: number): QueueState<M> {
  const expired = state.items.filter(
    (item) => item.state === 'handed_out' && item.lease_until !== undefined && item.lease_until <= now,
  )
  return expired.reduce((acc, item) => patchItem(acc, item.id, (it) => unlease(it, 'pending')), state)
}

/** An undelivered hand-out (the reader went away before it was written): back to pending at once. */
export function release<M extends InjectMessage>(state: QueueState<M>, injectId: string): QueueState<M> {
  const item = state.items.find((it) => it.state === 'handed_out' && it.inject_id === injectId)
  if (!item) return state
  const next = patchItem(state, item.id, (it) => unlease(it, 'pending'))
  return {
    ...next,
    turn: leaveTurn(state.turn, item),
    deferred: state.deferred.filter((id) => id !== item.id),
  }
}

export type ItemFilter = (item: QueueItem) => boolean

/** The first pending item that is not waiting out a claim retry and passes `filter`. */
export function firstPending<M extends InjectMessage>(
  state: QueueState<M>,
  now: number,
  filter: ItemFilter = () => true,
): QueueItem<M> | undefined {
  return state.items.find(
    (item) =>
      item.state === 'pending' && (item.retry_at === undefined || item.retry_at <= now) && filter(item),
  )
}

/** When the next claim retry is due, if any item waits for one. */
export function nextRetryAt(state: QueueState): number | undefined {
  const times = state.items.flatMap((item) =>
    item.state === 'pending' && item.retry_at !== undefined ? [item.retry_at] : [],
  )
  return times.length > 0 ? Math.min(...times) : undefined
}

/** True when handing out `item` would start a new peer turn. */
export const startsPeerTurn = (state: QueueState, item: QueueItem): boolean =>
  item.kind === 'ask' && state.turn === null

/** Budget gate before claiming: an ask that would start an over-budget peer turn goes to the inbox. */
export function admit<M extends InjectMessage>(
  state: QueueState<M>,
  id: string,
  now: number,
  perHour: number,
): { readonly state: QueueState<M>; readonly admitted: boolean } {
  const item = state.items.find((it) => it.id === id)
  if (item?.state !== 'pending') return { state, admitted: false }
  if (
    item.budget_exempt === true ||
    !startsPeerTurn(state, item) ||
    withinBudget(state.turn_starts, now, perHour)
  )
    return { state, admitted: true }
  const next = patchItem(state, id, (it) => ({ ...it, state: 'inbox_only', reason: 'over_budget' }))
  return { state: next, admitted: false }
}

export const beginClaim = <M extends InjectMessage>(state: QueueState<M>, id: string): QueueState<M> =>
  patchItem(state, id, (item) => (item.state === 'pending' ? { ...item, state: 'claiming' } : item))

/**
 * Claim succeeded → pending+claimed; terminal failure → dropped; transient failure → pending, but
 * skipped until `retryAt` so the items behind it are not blocked.
 */
export function settleClaim<M extends InjectMessage>(
  state: QueueState<M>,
  id: string,
  result: 'ok' | DropReason | 'retry',
  retryAt?: number,
): QueueState<M> {
  return patchItem(state, id, (item) => {
    if (item.state !== 'claiming') return item
    const { retry_at: _r, ...rest } = item
    if (result === 'ok') return { ...rest, state: 'pending', claimed: true }
    if (result === 'retry')
      return retryAt === undefined
        ? { ...rest, state: 'pending' }
        : { ...rest, state: 'pending', retry_at: retryAt }
    return { ...rest, state: 'dropped', reason: result }
  })
}

/** The local user opened the inbox: its over-budget / stale asks are handed out (in a gated turn). */
export function reopenInboxOnly<M extends InjectMessage>(state: QueueState<M>): QueueState<M> {
  const reopen = (item: QueueItem<M>): QueueItem<M> => {
    if (item.state !== 'inbox_only' || item.kind !== 'ask' || item.reason === 'not_injectable') return item
    const { reason: _r, ...rest } = item
    return { ...rest, state: 'pending', budget_exempt: true }
  }
  const items = state.items.map(reopen)
  return items.every((item, i) => item === state.items[i]) ? state : { ...state, items }
}

export interface HandOutOptions {
  readonly inject_id: string
  readonly channel: InjectChannel
  readonly now: number
  readonly leaseMs: number
  /** The envelope goes into a queue the agent drains later: join the peer turn when it starts. */
  readonly deferTurn?: boolean
}

const add = <T>(list: readonly T[], value: T): readonly T[] =>
  list.includes(value) ? list : [...list, value]

function joinTurn(
  state: QueueState,
  item: QueueItem,
  join: { readonly inject_id: string; readonly now: number; readonly started_by: PeerTurn['started_by'] },
): Pick<QueueState, 'turn' | 'turn_starts'> {
  if (item.kind !== 'ask') return { turn: state.turn, turn_starts: state.turn_starts }
  const turn: PeerTurn = state.turn ?? {
    ask_ids: [],
    room_ids: [],
    inject_ids: [],
    started_at: join.now,
    started_by: join.started_by,
    replied: [],
    nudged: false,
  }
  return {
    turn: {
      ...turn,
      ask_ids: add(turn.ask_ids, askIdOf(item)),
      inject_ids: add(turn.inject_ids, join.inject_id),
      room_ids: add(turn.room_ids, item.message.room_id),
    },
    turn_starts: state.turn ? state.turn_starts : [...pruneStarts(state.turn_starts, join.now), join.now],
  }
}

/** Hands a pending item out through exactly one channel; asks must be claimed first. */
export function handOut<M extends InjectMessage>(
  state: QueueState<M>,
  id: string,
  options: HandOutOptions,
): QueueState<M> {
  const item = state.items.find((it) => it.id === id)
  if (item?.state !== 'pending' || (item.kind === 'ask' && !item.claimed)) return state
  const next = patchItem(state, id, (it) => ({
    ...it,
    state: 'handed_out',
    inject_id: options.inject_id,
    channel: options.channel,
    lease_until: options.now + options.leaseMs,
  }))
  if (options.deferTurn === true)
    return item.kind === 'ask' ? { ...next, deferred: add(next.deferred, id) } : next
  const started_by = options.channel === 'take' ? 'user' : 'wake'
  return { ...next, ...joinTurn(state, item, { inject_id: options.inject_id, now: options.now, started_by }) }
}

/** The turn carrying deferred (queued) asks started: they join the peer turn, started by a wake. */
export function activateDeferred<M extends InjectMessage>(state: QueueState<M>, now: number): QueueState<M> {
  if (state.deferred.length === 0) return state
  let next: QueueState<M> = { ...state, deferred: [] }
  for (const id of state.deferred) {
    const item = next.items.find((it) => it.id === id)
    if (item?.inject_id === undefined) continue
    next = { ...next, ...joinTurn(next, item, { inject_id: item.inject_id, now, started_by: 'wake' }) }
  }
  return next
}

/** Delivery confirmed (the agent saw it): handed_out → injected. */
export function confirm<M extends InjectMessage>(
  state: QueueState<M>,
  injectIds: readonly string[],
): QueueState<M> {
  const ids = new Set(injectIds)
  return {
    ...state,
    items: state.items.map((item) =>
      item.state === 'handed_out' && item.inject_id !== undefined && ids.has(item.inject_id)
        ? {
            ...unlease(item, 'injected'),
            inject_id: item.inject_id,
            ...(item.channel ? { channel: item.channel } : {}),
          }
        : item,
    ),
  }
}

/** Records a `peers_reply` for an ask in the current turn. */
export function markReplied<M extends InjectMessage>(state: QueueState<M>, askId: string): QueueState<M> {
  const { turn } = state
  if (!turn?.ask_ids.includes(askId) || turn.replied.includes(askId)) return state
  return { ...state, turn: { ...turn, replied: [...turn.replied, askId] } }
}

export interface TurnEndInput {
  readonly inject_ids: readonly string[]
  readonly last_message?: string
  readonly reply_fallback: ReplyFallback
  /** The adapter has a turn-end hook that can continue the agent once. */
  readonly can_nudge: boolean
}

/**
 * Turn finished: confirms what the hook saw, then applies PROTOCOL §7.3. The peer turn stays open
 * after a nudge (the agent continues) and is cleared otherwise.
 */
export function endTurn<M extends InjectMessage>(
  state: QueueState<M>,
  input: TurnEndInput,
): { readonly state: QueueState<M>; readonly outcome: TurnEndOutcome } {
  const confirmed = confirm(state, [...input.inject_ids, ...(state.turn?.inject_ids ?? [])])
  const { turn } = confirmed
  if (!turn) return { state: confirmed, outcome: { kind: 'none' } }
  const open = turn.ask_ids.filter((id) => !turn.replied.includes(id))
  if (open.length === 0) return { state: { ...confirmed, turn: null }, outcome: { kind: 'done' } }
  if (input.can_nudge && !turn.nudged) {
    return {
      state: { ...confirmed, turn: { ...turn, nudged: true } },
      outcome: { kind: 'nudge', reminder: replyReminder(open), ask_ids: open },
    }
  }
  const replies = open.map((ask_id) =>
    decideReplyFallback({
      turn,
      ask_id,
      reply_fallback: input.reply_fallback,
      ...(input.last_message === undefined ? {} : { last_message: input.last_message }),
    }),
  )
  return { state: { ...confirmed, turn: null }, outcome: { kind: 'fallback', replies } }
}

/** The earliest lease expiry, so a caller can schedule `expireLeases`. */
export function nextLeaseExpiry(state: QueueState): number | undefined {
  const times = state.items.flatMap((item) =>
    item.state === 'handed_out' && item.lease_until !== undefined ? [item.lease_until] : [],
  )
  return times.length > 0 ? Math.min(...times) : undefined
}
