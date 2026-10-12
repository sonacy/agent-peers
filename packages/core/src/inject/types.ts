/** Injection-queue shapes (ARCHITECTURE §5 take/wait, §8 peer turns and budget; PROTOCOL §7). */

/** The one channel an envelope is handed out through. */
export type InjectChannel = 'wait' | 'take' | 'push'

/**
 * pending → claiming → handed_out → injected. A handed-out item whose lease expires (or is
 * released) goes back to pending. `inbox_only` and `dropped` are terminal.
 */
export type ItemState = 'pending' | 'claiming' | 'handed_out' | 'injected' | 'inbox_only' | 'dropped'

export type InboxReason = 'over_budget' | 'stale_replay' | 'not_injectable'
/** `claim_refused`: the hub will never let this session claim the ask (handle moved, room gone). */
export type DropReason = 'ask_closed' | 'ask_taken' | 'claim_refused'

/** The subset of a protocol message the queue relies on. */
export interface InjectMessage {
  readonly id: string
  readonly room_id: string
  readonly kind: string
  readonly re?: string | null
  readonly ts?: number
}

export interface QueueItem<M extends InjectMessage = InjectMessage> {
  readonly id: string
  readonly message: M
  /** `ask`: starts a peer turn and needs `ask.claim`. `reply`: wakes the asker. */
  readonly kind: 'ask' | 'reply'
  readonly state: ItemState
  readonly enqueued_at: number
  readonly claimed: boolean
  readonly inject_id?: string
  readonly channel?: InjectChannel
  readonly lease_until?: number
  readonly reason?: InboxReason | DropReason
  /** A transient claim failure: skip the item until then (no head-of-line blocking). */
  readonly retry_at?: number
  /** The local user asked to see this inbox-only ask: hand it out despite the budget. */
  readonly budget_exempt?: boolean
}

export interface PeerTurn {
  /** Asks injected into this turn (claimed by this session). */
  readonly ask_ids: readonly string[]
  readonly room_ids: readonly string[]
  readonly inject_ids: readonly string[]
  readonly started_at: number
  /** `wake`: an idle session was woken by the injection (wait/push); `user`: injected into a user's turn (take). */
  readonly started_by: 'wake' | 'user'
  /** Asks answered with `peers_reply` during the turn. */
  readonly replied: readonly string[]
  /** The turn-end reminder (PROTOCOL §7.3 step 1) has been used. */
  readonly nudged: boolean
}

export interface QueueState<M extends InjectMessage = InjectMessage> {
  readonly items: readonly QueueItem<M>[]
  readonly turn: PeerTurn | null
  /** Start times of peer turns within the budget window. */
  readonly turn_starts: readonly number[]
  /**
   * Asks pushed into a queue the agent drains later (Codex `codex queue`): they join the peer turn
   * only when the turn that carries them starts (its UserPromptSubmit), not when they are queued.
   */
  readonly deferred: readonly string[]
}

export interface HandOut<M extends InjectMessage = InjectMessage> {
  readonly item: QueueItem<M>
  readonly inject_id: string
  readonly envelope: string
}

/** What a reply fallback sends (PROTOCOL §7.3). */
export interface FallbackReply {
  readonly ask_id: string
  readonly state: 'answered' | 'failed'
  readonly text: string
  /** `meta.auto: true` on the reply. */
  readonly auto: boolean
}

export type TurnEndOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'done' }
  /** Continue the agent once with this reminder (Stop-hook `decision: block`). */
  | { readonly kind: 'nudge'; readonly reminder: string; readonly ask_ids: readonly string[] }
  | { readonly kind: 'fallback'; readonly replies: readonly FallbackReply[] }

export const emptyQueueState = <M extends InjectMessage>(): QueueState<M> => ({
  items: [],
  turn: null,
  turn_starts: [],
  deferred: [],
})
