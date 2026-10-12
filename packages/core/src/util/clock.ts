/** Injectable time source and timers, so tests can drive heartbeats and backoff deterministically. */
export type TimerHandle = unknown

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms),
  clearTimeout: (handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})
