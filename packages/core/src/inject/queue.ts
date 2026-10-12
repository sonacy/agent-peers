/**
 * One session's injection queue (ARCHITECTURE §5 take/wait, §8): claim before inject, hand each
 * envelope out exactly once through one channel, re-queue on lease expiry, enforce the peer-turn
 * budget, and drive the reply fallback at turn end. State lives in pure reducers (state.ts); this
 * class only sequences them around the async `ask.claim` and a clock.
 */
import { type ErrorCode, isPeersError, ulid } from '@agent-peers/protocol'
import type { ReplyFallback } from '../config/schemas'
import { DEFAULT_PEER_TURNS_PER_HOUR } from '../config/schemas'
import { type Clock, systemClock } from '../util/clock'
import { Emitter, type Listener, type Unsubscribe } from '../util/emitter'
import * as S from './state'
import {
  type DropReason,
  emptyQueueState,
  type HandOut,
  type InjectChannel,
  type InjectMessage,
  type PeerTurn,
  type QueueItem,
  type QueueState,
  type TurnEndOutcome,
} from './types'

/** How long a handed-out envelope waits for confirmation before it is re-queued. */
export const DEFAULT_LEASE_MS = 60_000
/** After a transient `ask.claim` failure the ask is skipped this long (the rest keep flowing). */
export const DEFAULT_CLAIM_RETRY_MS = 30_000

/** `ask.claim` errors after which the ask can never be claimed by this session. */
const TERMINAL_CLAIM: Readonly<Partial<Record<ErrorCode, DropReason>>> = {
  ask_closed: 'ask_closed',
  ask_taken: 'ask_taken',
  forbidden: 'claim_refused',
  target_not_found: 'claim_refused',
  room_not_found: 'claim_refused',
  invalid_params: 'claim_refused',
}

function terminalClaim(error: unknown): DropReason | undefined {
  if (!isPeersError(error)) return undefined
  return TERMINAL_CLAIM[error.code]
}

export interface NextOptions {
  /** Only items passing this are handed out (others stay pending). */
  readonly filter?: S.ItemFilter
  /** The channel is a queue the agent drains later: asks join the peer turn when it starts. */
  readonly deferTurn?: boolean
}

export interface InjectQueueOptions<M extends InjectMessage> {
  /** `ask.claim`; throw a PeersError `ask_closed` / `ask_taken` to drop the ask. */
  readonly claim: (askId: string) => Promise<unknown>
  /** Builds the envelope text (PROTOCOL §7.2) within `maxChars`. */
  readonly render: (item: QueueItem<M>, maxChars: number) => string
  readonly clock?: Pick<Clock, 'now'>
  readonly newInjectId?: () => string
  readonly leaseMs?: number
  readonly peerTurnsPerHour?: number
  readonly maxReplayAgeMs?: number
  readonly replyFallback?: ReplyFallback
  /** The adapter has a turn-end hook that can continue the agent once (PROTOCOL §7.3 step 1). */
  readonly canNudge?: boolean
  readonly claimRetryMs?: number
  /** A claim failed and the ask was skipped or dropped (for the bridge log). */
  readonly onClaimError?: (askId: string, error: unknown, outcome: DropReason | 'retry') => void
}

interface QueueEvents<M extends InjectMessage> {
  change: QueueState<M>
}

export class InjectQueue<M extends InjectMessage = InjectMessage> {
  private current: QueueState<M> = emptyQueueState<M>()
  private readonly events = new Emitter<QueueEvents<M>>()
  private readonly clock: Pick<Clock, 'now'>
  private readonly newInjectId: () => string

  constructor(private readonly options: InjectQueueOptions<M>) {
    this.clock = options.clock ?? systemClock
    this.newInjectId = options.newInjectId ?? (() => `inj_${ulid()}`)
  }

  get state(): QueueState<M> {
    return this.current
  }

  get peerTurn(): PeerTurn | null {
    return this.current.turn
  }

  /** Subscribes to state changes (used to wake `wait` long-polls). */
  onChange(listener: Listener<QueueState<M>>): Unsubscribe {
    return this.events.on('change', listener)
  }

  private set(next: QueueState<M>): void {
    if (next === this.current) return
    this.current = next
    this.events.emit('change', next)
  }

  /** Adds a message; returns its item (existing one for a duplicate). */
  enqueue(message: M, options: { readonly replay?: boolean } = {}): QueueItem<M> | undefined {
    this.set(
      S.enqueue(this.current, message, {
        now: this.clock.now(),
        ...(options.replay === undefined ? {} : { replay: options.replay }),
        ...(this.options.maxReplayAgeMs === undefined ? {} : { maxReplayAgeMs: this.options.maxReplayAgeMs }),
      }),
    )
    return this.current.items.find((item) => item.id === message.id)
  }

  /** Re-queues expired leases; returns the number of items now pending. */
  pendingCount(): number {
    this.set(S.expireLeases(this.current, this.clock.now()))
    return this.current.items.filter((item) => item.state === 'pending').length
  }

  /** Items that were routed to the local user's inbox instead of a turn. */
  inboxOnly(): readonly QueueItem<M>[] {
    return this.current.items.filter((item) => item.state === 'inbox_only')
  }

  nextLeaseExpiry(): number | undefined {
    return S.nextLeaseExpiry(this.current)
  }

  /** When a skipped ask's claim is retried next, if any. */
  nextRetryAt(): number | undefined {
    return S.nextRetryAt(this.current)
  }

  /**
   * Claims (asks) and hands out the next envelope through `channel`, or null when nothing is ready.
   * Never throws for a claim failure: the ask is dropped or skipped for a while, and the next item
   * is tried, so one bad ask cannot block the queue.
   */
  async next(
    channel: InjectChannel,
    maxChars: number,
    options: NextOptions = {},
  ): Promise<HandOut<M> | null> {
    for (;;) {
      this.set(S.expireLeases(this.current, this.clock.now()))
      const candidate = S.firstPending(this.current, this.clock.now(), options.filter)
      if (!candidate) return null
      const ready = await this.prepare(candidate)
      if (!ready) continue
      return this.handOut(ready, channel, maxChars, options.deferTurn === true)
    }
  }

  /** Budget + claim. Returns the item when it can be handed out, undefined to move on. */
  private async prepare(item: QueueItem<M>): Promise<QueueItem<M> | undefined> {
    const admitted = S.admit(this.current, item.id, this.clock.now(), this.perHour())
    this.set(admitted.state)
    if (!admitted.admitted) return undefined
    // Asks are (re-)claimed right before every hand-out: ask.claim is idempotent for the assignee.
    if (item.kind !== 'ask') return item
    this.set(S.beginClaim(this.current, item.id))
    try {
      await this.options.claim(S.askIdOf(item))
    } catch (error) {
      const outcome = terminalClaim(error) ?? 'retry'
      const retryAt = this.clock.now() + (this.options.claimRetryMs ?? DEFAULT_CLAIM_RETRY_MS)
      this.set(S.settleClaim(this.current, item.id, outcome, outcome === 'retry' ? retryAt : undefined))
      this.options.onClaimError?.(S.askIdOf(item), error, outcome)
      return undefined
    }
    this.set(S.settleClaim(this.current, item.id, 'ok'))
    const settled = this.current.items.find((it) => it.id === item.id)
    return settled?.state === 'pending' ? settled : undefined
  }

  private handOut(
    item: QueueItem<M>,
    channel: InjectChannel,
    maxChars: number,
    deferTurn: boolean,
  ): HandOut<M> | null {
    const inject_id = this.newInjectId()
    const envelope = this.options.render(item, maxChars)
    this.set(
      S.handOut(this.current, item.id, {
        inject_id,
        channel,
        now: this.clock.now(),
        leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
        deferTurn,
      }),
    )
    const handed = this.current.items.find((it) => it.id === item.id)
    return handed?.state === 'handed_out' ? { item: handed, inject_id, envelope } : null
  }

  /** Asks pushed into the agent's own queue, waiting for the turn that carries them. */
  get deferred(): readonly string[] {
    return this.current.deferred
  }

  /** The turn carrying the deferred asks started: they join the peer turn now. */
  activateDeferred(): void {
    this.set(S.activateDeferred(this.current, this.clock.now()))
  }

  /** Takes over a peer turn from a dropped queue (hub connection lost): its gate keeps applying. */
  adoptTurn(turn: PeerTurn): void {
    if (this.current.turn === null) this.set({ ...this.current, turn })
  }

  /** The local user opened the inbox: over-budget and stale asks are handed out like any other. */
  reopenInboxOnly(): void {
    this.set(S.reopenInboxOnly(this.current))
  }

  /** The agent saw these envelopes (e.g. its turn started). */
  confirm(injectIds: readonly string[]): void {
    this.set(S.confirm(this.current, injectIds))
  }

  /** The hand-out never reached the agent (socket closed, queue delete): re-queue now. */
  release(injectId: string): void {
    this.set(S.release(this.current, injectId))
  }

  /** `peers_reply` succeeded for this ask. */
  markReplied(askId: string): void {
    this.set(S.markReplied(this.current, askId))
  }

  /** Turn finished: clears the peer turn and returns the reply-fallback action, if any. */
  turnEnd(input: {
    readonly inject_ids?: readonly string[]
    readonly last_message?: string
  }): TurnEndOutcome {
    const { state, outcome } = S.endTurn(this.current, {
      inject_ids: input.inject_ids ?? [],
      reply_fallback: this.options.replyFallback ?? 'auto',
      can_nudge: this.options.canNudge ?? false,
      ...(input.last_message === undefined ? {} : { last_message: input.last_message }),
    })
    this.set(state)
    return outcome
  }

  /**
   * A peer turn outlived its agent turn (StopFailure, an interrupt) and a new turn starts: close it
   * without a nudge and without a final message, so unanswered asks fail with "no reply" and the
   * new turn's own final message is never sent as a peer reply (PROTOCOL §7.3).
   */
  abandonTurn(): TurnEndOutcome {
    if (this.current.turn === null) return { kind: 'none' }
    const { state, outcome } = S.endTurn(this.current, {
      inject_ids: [],
      reply_fallback: 'nudge',
      can_nudge: false,
    })
    this.set(state)
    return outcome
  }

  private perHour(): number {
    return this.options.peerTurnsPerHour ?? DEFAULT_PEER_TURNS_PER_HOUR
  }
}
