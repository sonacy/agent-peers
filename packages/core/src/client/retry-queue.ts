/**
 * Idempotent sends waiting for the next connection; they keep their `client_msg_id` (PROTOCOL §6.4).
 * A queued call has a deadline: its own timeout from when it was queued, and never past the hub's
 * dedup window counted from its first dispatch — a replay after that window could post it twice.
 */
import { DEDUP_WINDOW_MS, type ErrorCode, PeersError } from '@agent-peers/protocol'
import type { Clock, TimerHandle } from '../util/clock'
import type { PendingCall } from './inflight'

/** Margin under the hub's 10-minute dedup window for clock skew and the replay's own latency. */
export const DEDUP_SAFETY_MS = 60_000
/** Oldest first dispatch a retry may still replay. */
export const RETRY_WINDOW_MS = DEDUP_WINDOW_MS - DEDUP_SAFETY_MS

interface Entry {
  readonly call: PendingCall
  readonly timer: TimerHandle
}

export class RetryQueue {
  private entries: readonly Entry[] = []

  constructor(private readonly clock: Clock) {}

  get size(): number {
    return this.entries.length
  }

  push(call: PendingCall): void {
    const remaining = this.windowLeft(call)
    if (remaining <= 0) {
      call.reject(this.expired(call))
      return
    }
    const timer = this.clock.setTimeout(() => this.timeOut(call), Math.min(call.timeoutMs, remaining))
    this.entries = [...this.entries, { call, timer }]
  }

  /** Empties the queue and returns its calls, oldest first. Calls past the dedup window are rejected. */
  take(): readonly PendingCall[] {
    const taken = this.entries
    this.entries = []
    return taken.flatMap(({ call, timer }) => {
      this.clock.clearTimeout(timer)
      if (this.windowLeft(call) > 0) return [call]
      call.reject(this.expired(call))
      return []
    })
  }

  /** Re-addresses queued calls when a session comes back from reconnect with a new id. */
  remapSession(oldId: string, newId: string): void {
    if (oldId === newId) return
    this.entries = this.entries.map((entry) => {
      const params = entry.call.params as { readonly session_id?: unknown }
      return params.session_id === oldId
        ? { ...entry, call: { ...entry.call, params: { ...params, session_id: newId } } }
        : entry
    })
  }

  rejectAll(code: ErrorCode, message: string): void {
    for (const call of this.take()) call.reject(new PeersError(code, `${call.method}: ${message}`))
  }

  /** Time left before a replay could escape the hub's dedup; unbounded for a call never sent. */
  private windowLeft(call: PendingCall): number {
    if (call.firstSentAt === undefined) return Number.POSITIVE_INFINITY
    return call.firstSentAt + RETRY_WINDOW_MS - this.clock.now()
  }

  private expired(call: PendingCall): PeersError {
    return new PeersError('disconnected', `${call.method}: not retried, the hub's dedup window has passed`)
  }

  private timeOut(call: PendingCall): void {
    const before = this.entries.length
    // Matched by `resolve`: remapSession replaces the call object but keeps its callbacks.
    this.entries = this.entries.filter((e) => e.call.resolve !== call.resolve)
    if (this.entries.length === before) return
    call.reject(new PeersError('timeout', `${call.method} timed out while waiting to reconnect`))
  }
}
