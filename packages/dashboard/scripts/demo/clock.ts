/**
 * A hub clock that can be set back in time while the demo seeds, so rooms, asks and knocks carry
 * realistic ages (`10 月 6 日`, `昨天`, `2 小时前`). It only ever moves forward: each `at()` must be
 * later than the last. Timers are real timers, so presence and heartbeats keep working.
 */
import type { Clock } from '@agent-peers/hub'

export interface DemoClock {
  readonly clock: Clock
  /** Hub time becomes `now - agoMs` (until the next call). */
  at(agoMs: number): void
  /** Back to real time. */
  present(): void
  readonly offsetMs: number
}

export function createDemoClock(now: () => number = Date.now): DemoClock {
  let offset = 0
  let started = false
  return {
    clock: {
      now: () => now() - offset,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    at(agoMs) {
      if (!Number.isFinite(agoMs) || agoMs < 0) throw new Error(`demo clock: bad offset ${agoMs}`)
      if (started && agoMs > offset) throw new Error('demo clock only moves forward')
      started = true
      offset = agoMs
    },
    present() {
      started = true
      offset = 0
    },
    get offsetMs() {
      return offset
    },
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
