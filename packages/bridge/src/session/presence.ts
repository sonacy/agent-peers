/**
 * What the session's card says about it (PROTOCOL §3, §5.2, §7.1): activity from hooks, and the
 * effective injection tier (hooks seen, injector capability, listen mode). Changes are sent as one
 * debounced `session.update`.
 */
import type { Clock } from '@agent-peers/core'
import type { Activity, InjectTier, SessionPatch } from '@agent-peers/protocol'
import type { Injector, InjectTarget } from '../inject/injector'
import type { SurfaceDescriptor } from '../surface/surfaces'
import { PatchDebouncer } from './signals'

/** Listen mode keeps advertising `push` this long after a `peers_wait` returns (the agent re-arms). */
export const LISTEN_LINGER_MS = 60 * 1000
/**
 * A waiter that returned without waking the session (its poll slice ended, it was superseded) is
 * normally replaced at once; after this long without one, the session can no longer be woken.
 */
export const WAITER_GRACE_MS = 15 * 1000

export interface PresenceDeps {
  readonly localKey: string
  readonly descriptor: SurfaceDescriptor
  readonly injector: Injector
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly update: (patch: SessionPatch) => Promise<void>
}

export class CardPresence {
  private activityState: Activity = 'unknown'
  private hookedState: boolean
  private listeners = 0
  private listenUntil = 0
  private waiters = 0
  private waiterUntil = 0
  /** The last waiter woke the session; the turn's Stop arms the next one. */
  private rearmPending = false
  private lastTier: InjectTier
  private ended = false
  private readonly patcher: PatchDebouncer
  private readonly unsubscribeTier: () => void

  constructor(
    private readonly deps: PresenceDeps,
    init: { readonly hooked: boolean; readonly tier: InjectTier },
  ) {
    this.hookedState = init.hooked
    this.lastTier = init.tier
    this.patcher = new PatchDebouncer(deps.update, deps.clock, deps.log)
    this.unsubscribeTier = deps.injector.onTierChange?.(() => this.syncTier()) ?? (() => undefined)
  }

  get activity(): Activity {
    return this.activityState
  }

  get hooked(): boolean {
    return this.hookedState
  }

  get target(): InjectTarget {
    return {
      localKey: this.deps.localKey,
      surface: this.deps.descriptor.surface,
      activity: this.activityState,
      hooked: this.hookedState,
      waiting: this.waiters > 0 || this.rearmPending || this.deps.clock.now() < this.waiterUntil,
    }
  }

  get tier(): InjectTier {
    if (this.listeners > 0 || this.deps.clock.now() < this.listenUntil) return 'push'
    const fallback = this.hookedState ? this.deps.descriptor.hookedTier : this.deps.descriptor.baseTier
    return this.deps.injector.tier?.(this.target) ?? fallback
  }

  noteHook(): void {
    if (this.hookedState) return
    this.hookedState = true
    this.syncTier()
  }

  /** Returns true when the activity changed. */
  setActivity(state: Activity): boolean {
    if (state === this.activityState) return false
    this.activityState = state
    this.patcher.push({ activity: state })
    return true
  }

  setModel(model: string): void {
    this.patcher.push({ model })
  }

  beginListen(): void {
    this.listeners += 1
    this.syncTier()
  }

  endListen(): void {
    this.listeners = Math.max(0, this.listeners - 1)
    this.listenUntil = this.deps.clock.now() + LISTEN_LINGER_MS
    this.deps.clock.setTimeout(() => this.syncTier(), LISTEN_LINGER_MS + 1)
  }

  /** A `wait` long-poll started (Claude Code asyncRewake waiter). */
  beginWait(): void {
    this.waiters += 1
    this.rearmPending = false
    this.syncTier()
  }

  /** A `wait` ended; `woke`: it handed out an envelope (the session is being woken). */
  endWait(woke: boolean): void {
    this.waiters = Math.max(0, this.waiters - 1)
    if (woke) this.rearmPending = true
    else this.lingerWaiter()
  }

  /** The woken turn ended: its Stop arms a new waiter, which should arrive within the grace period. */
  noteTurnEnd(): void {
    if (!this.rearmPending) return
    this.rearmPending = false
    this.lingerWaiter()
  }

  private lingerWaiter(): void {
    this.waiterUntil = this.deps.clock.now() + WAITER_GRACE_MS
    this.deps.clock.setTimeout(() => this.syncTier(), WAITER_GRACE_MS + 1)
  }

  syncTier(): void {
    const tier = this.tier
    if (tier === this.lastTier || this.ended) return
    this.lastTier = tier
    this.patcher.push({ inject: tier })
  }

  flush(): Promise<void> {
    return this.patcher.flush()
  }

  stop(): void {
    this.ended = true
    this.unsubscribeTier()
    this.patcher.cancel()
  }
}
