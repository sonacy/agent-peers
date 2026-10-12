/** JSON-RPC id correlation for requests in flight on one socket, each with its own timeout. */

import {
  IDEMPOTENT_METHODS,
  type MethodName,
  PeersError,
  parseResult,
  type ResultOf,
  toPeersError,
} from '@agent-peers/protocol'
import type { Clock, TimerHandle } from '../util/clock'

export interface PendingCall {
  readonly method: string
  readonly params: unknown
  readonly idempotent: boolean
  /** Handshake / resync / ping traffic: never queued for retry. */
  readonly internal: boolean
  readonly timeoutMs: number
  /** When the call first went out on a socket; undefined until then (bounds retries, §6.4). */
  readonly firstSentAt?: number
  readonly resolve: (value: unknown) => void
  readonly reject: (error: PeersError) => void
}

export interface CallInit<M extends MethodName> {
  readonly method: M
  readonly params: unknown
  readonly internal: boolean
  readonly timeoutMs: number
  readonly resolve: (value: ResultOf<M>) => void
  readonly reject: (error: PeersError) => void
}

/** A call whose result is validated against the method's result schema before it resolves. */
export function createCall<M extends MethodName>(init: CallInit<M>): PendingCall {
  return {
    method: init.method,
    params: init.params,
    internal: init.internal,
    idempotent: IDEMPOTENT_METHODS.has(init.method),
    timeoutMs: init.timeoutMs,
    resolve: (value) => {
      try {
        init.resolve(parseResult(init.method, value))
      } catch (error) {
        init.reject(toPeersError(error, 'invalid_result'))
      }
    },
    reject: init.reject,
  }
}

interface Entry {
  readonly call: PendingCall
  readonly timer: TimerHandle
}

export class InFlight {
  private readonly entries = new Map<number, Entry>()
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  get size(): number {
    return this.entries.size
  }

  /** Registers a call and returns its JSON-RPC id. The call is rejected with `timeout` if unanswered. */
  add(call: PendingCall): number {
    const id = this.nextId
    this.nextId += 1
    const timer = this.clock.setTimeout(() => {
      if (!this.entries.delete(id)) return
      call.reject(new PeersError('timeout', `${call.method} timed out after ${call.timeoutMs} ms`))
    }, call.timeoutMs)
    this.entries.set(id, { call, timer })
    return id
  }

  /** Removes and returns the call for `id`, or undefined if unknown (late or duplicate response). */
  take(id: number | string | null): PendingCall | undefined {
    if (typeof id !== 'number') return undefined
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.entries.delete(id)
    this.clock.clearTimeout(entry.timer)
    return entry.call
  }

  /** Removes every call (oldest first) and cancels their timers. */
  drain(): readonly PendingCall[] {
    const calls = [...this.entries.values()].map((entry) => {
      this.clock.clearTimeout(entry.timer)
      return entry.call
    })
    this.entries.clear()
    return calls
  }
}
