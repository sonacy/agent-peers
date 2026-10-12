import { describe, expect, it } from 'bun:test'
import { createRateLimiter } from '../../src/services/rate-limit'
import { FakeClock } from '../helpers/fake-clock'

describe('rate limiter memory', () => {
  it('prunes keys with no hit inside the window', () => {
    const clock = new FakeClock()
    const limiter = createRateLimiter(clock, 2, 1000)
    limiter.take('a')
    limiter.take('b')
    clock.advance(500)
    limiter.take('b')
    clock.advance(600)
    expect(limiter.prune()).toBe(1)
    expect(limiter.size).toBe(1)
    clock.advance(1000)
    expect(limiter.prune()).toBe(1)
    expect(limiter.size).toBe(0)
  })

  it('prunes lazily once a window has passed, so distinct keys do not pile up', () => {
    const clock = new FakeClock()
    const limiter = createRateLimiter(clock, 5, 1000)
    for (let i = 0; i < 50; i += 1) limiter.take(`ip-${i}`)
    expect(limiter.size).toBe(50)
    clock.advance(1001)
    limiter.take('late')
    expect(limiter.size).toBe(1)
  })

  it('caps tracked keys, evicting the least recently used', () => {
    const clock = new FakeClock()
    const limiter = createRateLimiter(clock, 1, 60_000, 3)
    limiter.take('a')
    limiter.take('b')
    limiter.take('c')
    expect(limiter.take('a').ok).toBe(false)
    limiter.take('d')
    expect(limiter.size).toBe(3)
    expect(limiter.take('b').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(false)
  })
})
