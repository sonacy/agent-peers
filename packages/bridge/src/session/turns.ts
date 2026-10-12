/**
 * The peer-turn lifecycle of one session (ARCHITECTURE §8, PROTOCOL §7.3), driven by lifecycle hooks:
 * - `begin` (UserPromptSubmit): closes a peer turn an earlier agent turn left open (StopFailure, an
 *   interrupt) with "no reply", unless the prompt carries our own queued envelope; queued asks join;
 * - `end` (Stop): nudge once, then fallback replies, every one attempted even if another fails;
 * - Codex: the open peer turn is bound to the agent turn id that runs it, so a turn-scoped
 *   `peers_hook` call from another source (the model itself) can be refused.
 */
import type { InjectQueue, PeerTurn, TurnEndOutcome } from '@agent-peers/core'
import type { Activity, ReplyState } from '@agent-peers/protocol'
import type { Delivery } from './delivery'
import type { PeerMessage } from './signals'

export interface TurnHost {
  readonly queue: InjectQueue<PeerMessage>
  readonly delivery: Delivery
  reply(
    askId: string,
    text: string,
    state: ReplyState,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
  setActivity(state: Activity): void
  /** Waiter re-arm bookkeeping: the woken turn ended. */
  readonly presence: { noteTurnEnd(): void }
  log(line: string): void
}

export class Turns {
  private boundTurnId: string | undefined
  private namedTurns = false

  constructor(private readonly host: TurnHost) {}

  /** Codex: the turn id the open peer turn belongs to. */
  get turnId(): string | undefined {
    return this.boundTurnId
  }

  /**
   * The agent's hooks fill `turn_id` (seen at least once). Until then a turn-scoped event without
   * one cannot be told apart from a hook whose template Codex left unfilled, so it is accepted.
   */
  get hooksNameTurns(): boolean {
    return this.namedTurns
  }

  noteTurnId(turnId: string | undefined): void {
    if (turnId !== undefined) this.namedTurns = true
  }

  async begin(turnId?: string): Promise<void> {
    const { stale, carrier } = this.host.delivery.beginTurn()
    const sameTurn = turnId !== undefined && turnId === this.boundTurnId
    if (stale && !sameTurn) await this.sendFallbacks(this.host.queue.abandonTurn())
    this.host.delivery.activateQueued()
    this.unbindIfClosed()
    // The prompt carrying our envelope runs the peer turn from here, possibly under a new turn id.
    if (carrier && turnId !== undefined && this.host.queue.peerTurn !== null) this.boundTurnId = turnId
    this.bind(turnId)
    this.host.setActivity('busy')
  }

  async end(input: { inject_ids?: readonly string[]; last_message?: string }): Promise<TurnEndOutcome> {
    const outcome = this.host.queue.turnEnd(input)
    this.host.delivery.noteTurnEnd()
    this.host.presence.noteTurnEnd()
    this.unbindIfClosed()
    await this.sendFallbacks(outcome)
    return outcome
  }

  /** Binds the open peer turn to the agent turn that runs it (first binding wins). */
  bind(turnId: string | undefined): void {
    if (turnId !== undefined && this.boundTurnId === undefined && this.host.queue.peerTurn !== null)
      this.boundTurnId = turnId
  }

  /** A Stop-hook continuation carries a peer envelope: its prompt is not a new user turn. */
  expectCarrier(): void {
    this.host.delivery.expectCarrier()
  }

  /** Carries a peer turn over from a session object dropped with the hub connection. */
  adopt(turn: PeerTurn): void {
    this.host.queue.adoptTurn(turn)
  }

  /** Asks handed out inside a (gated) peer turn, for PermissionRequest pre-approval. */
  gatedAskIds(): readonly string[] {
    const deferred = new Set(this.host.queue.deferred)
    return this.host.queue.state.items
      .filter((i) => i.kind === 'ask' && (i.state === 'injected' || i.state === 'handed_out'))
      .filter((i) => !deferred.has(i.id))
      .map((i) => i.id)
  }

  private unbindIfClosed(): void {
    if (this.host.queue.peerTurn === null) this.boundTurnId = undefined
  }

  /** Every fallback is attempted even when one fails (the turn is already closed); failures are logged. */
  private async sendFallbacks(outcome: TurnEndOutcome): Promise<void> {
    if (outcome.kind !== 'fallback') return
    const results = await Promise.allSettled(
      outcome.replies.map((r) =>
        this.host.reply(r.ask_id, r.text, r.state, r.auto ? { auto: true } : undefined),
      ),
    )
    results.forEach((result, i) => {
      if (result.status === 'rejected')
        this.host.log(`fallback reply to ${outcome.replies[i]?.ask_id} failed: ${String(result.reason)}`)
    })
  }
}
