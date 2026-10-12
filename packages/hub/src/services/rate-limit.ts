/** Sliding-window rate limiting (§8: 30 messages per minute per member; redeems per IP). */
import { PeersError } from '@agent-peers/protocol'
import type { Clock } from '../clock'

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number }

export interface RateLimiter {
  /** Records a hit for `key` when under the limit. */
  take(key: string): RateDecision
  /** Like `take`, but throws `rate_limited` with `retry_after_ms`. */
  enforce(key: string, what?: string): void
  reset(key?: string): void
  /** Drops keys with no hit inside the window; returns how many were dropped. */
  prune(): number
  /** Number of keys currently tracked. */
  readonly size: number
}

/** Hard bound on tracked keys, so a flood of distinct keys can't grow memory without limit. */
export const MAX_RATE_KEYS = 100_000

export function createRateLimiter(
  clock: Clock,
  limit: number,
  windowMs: number,
  maxKeys: number = MAX_RATE_KEYS,
): RateLimiter {
  /** Private bookkeeping: each key maps to an immutable list of hit times inside the window. */
  const hits = new Map<string, readonly number[]>()
  let lastPrune = clock.now()

  const prune = (): number => {
    const cutoff = clock.now() - windowMs
    lastPrune = clock.now()
    const idle = [...hits].filter(([, times]) => (times.at(-1) ?? 0) <= cutoff).map(([key]) => key)
    for (const key of idle) hits.delete(key)
    return idle.length
  }

  /** Keeps the map bounded: idle keys go first; past the cap, the least recently used ones. */
  const makeRoom = (now: number) => {
    if (now - lastPrune >= windowMs) prune()
    while (hits.size >= maxKeys) {
      const oldest = hits.keys().next().value
      if (oldest === undefined) break
      hits.delete(oldest)
    }
  }

  const take = (key: string): RateDecision => {
    const now = clock.now()
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs)
    hits.delete(key)
    if (recent.length >= limit) {
      const oldest = recent[0] ?? now
      hits.set(key, recent)
      return { ok: false, retryAfterMs: Math.max(1, oldest + windowMs - now) }
    }
    makeRoom(now)
    hits.set(key, [...recent, now])
    return { ok: true }
  }

  return {
    take,
    prune,
    get size() {
      return hits.size
    },
    enforce(key, what = 'requests') {
      const decision = take(key)
      if (!decision.ok) {
        throw new PeersError('rate_limited', `too many ${what}; retry later`, {
          retry_after_ms: decision.retryAfterMs,
        })
      }
    },
    reset(key) {
      if (key === undefined) hits.clear()
      else hits.delete(key)
    },
  }
}
