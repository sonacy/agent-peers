/**
 * Deterministic row ids for the seeded demo: valid ULIDs whose time part counts up from a fixed
 * epoch and whose random part comes from a seeded PRNG. Seeded in a fixed order, the same agent and
 * member get the same id (and so the same hashed face color) on every run, which keeps design-QA
 * screenshots comparable. Ids stay monotonic, so id-ordered lists keep creation order.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16
/** 2026-01-01T00:00:00Z: before any real ULID a restarted hub would mint, so those sort later. */
export const DEMO_ID_EPOCH = Date.UTC(2026, 0, 1)

/** mulberry32: a tiny, fast, seeded 32-bit PRNG returning [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function encodeTime(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`demo ids: bad time ${ms}`)
  let rest = ms
  let out = ''
  for (let i = 0; i < TIME_CHARS; i++) {
    out = (CROCKFORD[rest % 32] ?? '0') + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/** A ULID factory: each call returns the next id in a fixed sequence for `seed`. */
export function createDemoIds(seed = 2026, epoch = DEMO_ID_EPOCH): () => string {
  const random = seededRandom(seed)
  let next = 0
  return () => {
    const time = encodeTime(epoch + next++)
    const tail = Array.from({ length: RANDOM_CHARS }, () => CROCKFORD[Math.floor(random() * 32)] ?? '0')
    return time + tail.join('')
  }
}
