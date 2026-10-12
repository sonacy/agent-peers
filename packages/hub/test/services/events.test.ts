import { describe, expect, it } from 'bun:test'
import { isPeersError } from '@agent-peers/protocol'
import { silentLogger } from '../../src/config'
import { createEventBus } from '../../src/services/events'
import { createRateLimiter } from '../../src/services/rate-limit'
import { FakeClock } from '../helpers/fake-clock'

describe('event bus', () => {
  it('filters by member and isolates failing listeners', () => {
    const bus = createEventBus(silentLogger)
    const seen: string[] = []
    const off = bus.onMember('m1', (e) => seen.push(e.name))
    bus.on(() => {
      throw new Error('boom')
    })
    expect(bus.listenerCount).toBe(2)
    const data = { room_id: 'r1', change: 'members' as const }
    bus.emit({ name: 'room', data, memberIds: ['m1'] })
    bus.emit({ name: 'room', data, memberIds: ['m2'] })
    off()
    bus.emit({ name: 'room', data, memberIds: ['m1'] })
    expect(seen).toEqual(['room'])
  })
})

describe('rate limiter', () => {
  it('allows N per window and reports retry_after_ms', () => {
    const clock = new FakeClock()
    const limiter = createRateLimiter(clock, 2, 1000)
    expect(limiter.take('k').ok).toBe(true)
    clock.advance(400)
    expect(limiter.take('k').ok).toBe(true)
    const denied = limiter.take('k')
    expect(denied).toEqual({ ok: false, retryAfterMs: 600 })
    try {
      limiter.enforce('k', 'redeems')
    } catch (error) {
      expect(isPeersError(error, 'rate_limited')).toBe(true)
    }
    limiter.reset('k')
    expect(limiter.take('k').ok).toBe(true)
    limiter.reset()
    clock.advance(1000)
    expect(limiter.take('k').ok).toBe(true)
  })
})
