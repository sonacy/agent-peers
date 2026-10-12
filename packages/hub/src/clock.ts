/** Injectable time source and timers, so presence, TTLs and sweepers can be driven by tests. */
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

/** Anything with an `error` method (the hub's Logger). */
interface ErrorSink {
  error(message: string, error?: unknown): void
}

/**
 * Wraps a timer callback so a throw (a closed database, SQLITE_BUSY) is logged instead of escaping
 * as an uncaught exception that could take the hub process down.
 */
export function guarded(logger: ErrorSink, label: string, fn: () => void): () => void {
  return () => {
    try {
      fn()
    } catch (error) {
      logger.error(`${label} failed`, error)
    }
  }
}
