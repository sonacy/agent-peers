import { describe, expect, it } from 'bun:test'
import { backoffDelay, createBackoff, DEFAULT_BACKOFF, resolveBackoff } from '../src/util/backoff'

describe('backoffDelay', () => {
  it('doubles from 1s and caps at 30s without jitter', () => {
    const mid = () => 0.5
    const delays = [0, 1, 2, 3, 4, 5, 6, 10].map((a) => backoffDelay(a, DEFAULT_BACKOFF, mid))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })

  it('applies ±20% jitter', () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(800)
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999999)).toBe(1200)
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0)).toBe(24000)
  })

  it('treats negative and fractional attempts as sane values', () => {
    expect(backoffDelay(-3, DEFAULT_BACKOFF, () => 0.5)).toBe(1000)
    expect(backoffDelay(1.7, DEFAULT_BACKOFF, () => 0.5)).toBe(2000)
  })
})

describe('resolveBackoff', () => {
  it('merges partial options', () => {
    expect(resolveBackoff({ initialMs: 10, maxMs: 40 })).toEqual({
      initialMs: 10,
      maxMs: 40,
      factor: 2,
      jitter: 0.2,
    })
  })

  it('rejects invalid options', () => {
    expect(() => resolveBackoff({ initialMs: 0 })).toThrow(RangeError)
    expect(() => resolveBackoff({ initialMs: 100, maxMs: 10 })).toThrow(RangeError)
    expect(() => resolveBackoff({ factor: 0.5 })).toThrow(RangeError)
    expect(() => resolveBackoff({ jitter: 1 })).toThrow(RangeError)
    expect(() => resolveBackoff({ jitter: -0.1 })).toThrow(RangeError)
  })
})

describe('createBackoff', () => {
  it('advances and resets', () => {
    const backoff = createBackoff({ initialMs: 10, maxMs: 50, jitter: 0 })
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([10, 20, 40, 50])
    expect(backoff.attempt).toBe(4)
    backoff.reset()
    expect(backoff.attempt).toBe(0)
    expect(backoff.next()).toBe(10)
  })
})
