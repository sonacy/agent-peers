/**
 * How one session's envelopes leave the bridge (ARCHITECTURE §5, §6.2, §8; PROTOCOL §7):
 * - `handOut`: one envelope through `wait` / `take` / a tool. Inline channels (a tool result, a hook's
 *   own output) are delivered once returned, so they are confirmed at once; only the waiter's socket
 *   hand-out stays leased until the woken turn reports `busy`.
 * - `pump`: pushes into the agent's own queue (`codex queue`) when the injector can reach the idle
 *   session. At most one push is in flight; a pushed ask joins the peer turn only when the turn that
 *   carries it starts. Pushes run on their own chain, so a slow `codex queue` never stalls inbound
 *   journaling.
 * - On a gated surface whose gate is not active (hooks missing or untrusted), asks are never handed
 *   to unattended channels (`wait`, `push`): they wait for the local user's `peers_inbox`.
 */
import type {
  Clock,
  HandOut,
  InjectChannel,
  InjectQueue,
  SessionJournal,
  TimerHandle,
} from '@agent-peers/core'
import type { Injector, InjectTarget } from '../inject/injector'
import type { SurfaceDescriptor } from '../surface/surfaces'
import type { ChangeSignal, PeerMessage } from './signals'

export interface DeliveryHost {
  readonly queue: InjectQueue<PeerMessage>
  readonly changes: ChangeSignal
  readonly journal: Promise<SessionJournal>
  readonly accepting: boolean
  readonly ended: boolean
  readonly hooked: boolean
  readonly target: InjectTarget
  log(line: string): void
}

export interface DeliveryDeps {
  readonly descriptor: SurfaceDescriptor
  readonly injector: Injector
  readonly clock: Clock
}

export interface HandOutOptions {
  /** The envelope is returned to the agent directly (tool result, hook output): confirm it now. */
  readonly inline?: boolean
}

/** Channels nobody local is watching: an ask there runs a peer turn unattended. */
const UNATTENDED: ReadonlySet<InjectChannel> = new Set(['wait', 'push'])

export class Delivery {
  private pushes: Promise<void> = Promise.resolve()
  private pushInFlight = false
  private carrierExpected = false
  private retryTimer: TimerHandle | undefined

  constructor(
    private readonly host: DeliveryHost,
    private readonly deps: DeliveryDeps,
  ) {}

  /** ARCHITECTURE §8 item 5: a gated surface without an active gate never runs unattended peer turns. */
  get gateInactive(): boolean {
    return this.deps.descriptor.gated && !this.host.hooked
  }

  private filterFor(channel: InjectChannel) {
    if (!UNATTENDED.has(channel) || !this.gateInactive) return undefined
    return (item: { readonly kind: string }) => item.kind !== 'ask'
  }

  /** Asks held back from unattended channels because the gate is inactive. */
  heldAsks(): number {
    if (!this.gateInactive) return 0
    return this.host.queue.state.items.filter((i) => i.kind === 'ask' && i.state === 'pending').length
  }

  async handOut(
    channel: InjectChannel,
    maxChars: number,
    options: HandOutOptions = {},
  ): Promise<HandOut<PeerMessage> | null> {
    if (!this.host.accepting || this.host.ended) return null
    const filter = this.filterFor(channel)
    const out = await this.host.queue.next(channel, maxChars, filter ? { filter } : {})
    this.scheduleRetry()
    if (!out) return null
    try {
      await this.record(out, channel)
    } catch (error) {
      // Not journaled: nobody got it, so it goes back to the queue at once instead of sitting leased.
      this.host.queue.release(out.inject_id)
      throw error
    }
    if (options.inline === true) this.host.queue.confirm([out.inject_id])
    return out
  }

  private async record(out: HandOut<PeerMessage>, channel: InjectChannel): Promise<void> {
    const journal = await this.host.journal
    if (out.item.kind === 'ask') await journal.markClaimed(out.item.id)
    await journal.markInjected(out.item.id, channel, out.inject_id)
    await journal.markRead([out.item.id])
  }

  /** A skipped ask (transient claim failure) is retried when its time comes. */
  private scheduleRetry(): void {
    const at = this.host.queue.nextRetryAt()
    if (at === undefined || this.retryTimer !== undefined || this.host.ended) return
    this.retryTimer = this.deps.clock.setTimeout(
      () => {
        this.retryTimer = undefined
        this.host.changes.notify()
        this.pump()
      },
      Math.max(0, at - this.deps.clock.now()),
    )
  }

  /** Pushes pending envelopes when the injector can reach the idle session. */
  pump(): void {
    this.pushes = this.pushes
      .then(() => this.pushPending())
      .catch((error: unknown) => this.host.log(`push: ${String(error)}`))
  }

  /** Resolves when queued pushes have run. */
  settled(): Promise<void> {
    return this.pushes
  }

  private async pushPending(): Promise<void> {
    const target = this.host.target
    if (this.host.ended || !this.host.accepting || target.activity === 'busy' || this.pushInFlight) return
    if (!this.deps.injector.canPush(target) || this.host.queue.pendingCount() === 0) return
    const filter = this.filterFor('push')
    const out = await this.host.queue.next('push', this.deps.descriptor.maxInjectChars, {
      deferTurn: true,
      ...(filter ? { filter } : {}),
    })
    this.scheduleRetry()
    if (!out) return
    const result = await this.deps.injector
      .push(out.envelope, { ...target, injectId: out.inject_id })
      .catch((error: unknown) => {
        this.host.log(`injector ${this.deps.injector.kind} failed: ${String(error)}`)
        return 'unsupported' as const
      })
    if (result === 'unsupported') {
      this.host.queue.release(out.inject_id)
      return
    }
    // The agent's own queue owns it now: no lease, no second push until its turn starts.
    this.pushInFlight = true
    this.carrierExpected = true
    this.host.queue.confirm([out.inject_id])
    await this.record(out, 'push').catch((error: unknown) =>
      this.host.log(`journaling push ${out.inject_id} failed: ${String(error)}`),
    )
  }

  /** A turn started: every envelope handed out so far reached the agent. */
  confirmHandedOut(): void {
    const ids = this.host.queue.state.items.flatMap((item) =>
      item.state === 'handed_out' && item.inject_id !== undefined ? [item.inject_id] : [],
    )
    if (ids.length > 0) this.host.queue.confirm(ids)
  }

  /** A Stop-hook continuation carries a peer envelope: the next prompt is that envelope's turn. */
  expectCarrier(): void {
    this.carrierExpected = true
  }

  /**
   * UserPromptSubmit. `carrier`: this prompt carries our own envelope (a queued push, a Stop-hook
   * continuation). Otherwise a peer turn still open from an earlier agent turn (StopFailure, an
   * interrupt) is `stale` and must be abandoned.
   */
  beginTurn(): { readonly stale: boolean; readonly carrier: boolean } {
    const carrier = this.carrierExpected
    this.carrierExpected = false
    this.pushInFlight = false
    return { stale: !carrier && this.host.queue.peerTurn !== null, carrier }
  }

  /** Called after `abandonTurn` (if any) so queued asks start a fresh peer turn. */
  activateQueued(): void {
    this.host.queue.activateDeferred()
  }

  noteTurnEnd(): void {
    this.carrierExpected = false
  }

  stop(): void {
    if (this.retryTimer !== undefined) this.deps.clock.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}
