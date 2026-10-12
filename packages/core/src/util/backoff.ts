/** Exponential backoff with symmetric jitter (PROTOCOL §5.1: 1 s → 30 s, ±20 %). */
export interface BackoffOptions {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
  /** Fraction of the delay used as +/- jitter, e.g. 0.2 for ±20 %. */
  readonly jitter: number
}

export const DEFAULT_BACKOFF: BackoffOptions = Object.freeze({
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
})

export type RandomSource = () => number

/** Delay before reconnect attempt `attempt` (0-based). `random` returns a value in [0, 1). */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: RandomSource = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const base = Math.min(options.maxMs, options.initialMs * options.factor ** safeAttempt)
  const spread = (random() * 2 - 1) * options.jitter
  return Math.max(0, Math.round(base * (1 + spread)))
}

export function resolveBackoff(partial?: Partial<BackoffOptions>): BackoffOptions {
  const merged = { ...DEFAULT_BACKOFF, ...partial }
  if (merged.initialMs <= 0 || merged.maxMs < merged.initialMs || merged.factor < 1) {
    throw new RangeError('invalid backoff options')
  }
  if (merged.jitter < 0 || merged.jitter >= 1) throw new RangeError('backoff jitter must be in [0, 1)')
  return Object.freeze(merged)
}

/** Stateful helper: `next()` yields successive delays, `reset()` starts over. */
export interface Backoff {
  readonly attempt: number
  next(): number
  reset(): void
}

export function createBackoff(
  partial?: Partial<BackoffOptions>,
  random: RandomSource = Math.random,
): Backoff {
  const options = resolveBackoff(partial)
  let attempt = 0
  return {
    get attempt() {
      return attempt
    },
    next() {
      const delay = backoffDelay(attempt, options, random)
      attempt += 1
      return delay
    },
    reset() {
      attempt = 0
    },
  }
}
