import { describe, expect, it } from 'bun:test'
import { DEDUP_WINDOW_MS, type PeersError } from '@agent-peers/protocol'
import type { PendingCall } from '../src/client/inflight'
import { DEDUP_SAFETY_MS, RETRY_WINDOW_MS, RetryQueue } from '../src/client/retry-queue'
import { FakeClock } from './helpers/fake-clock'

interface Probe {
  readonly call: PendingCall
  readonly errors: PeersError[]
}

const probe = (overrides: Partial<PendingCall> = {}): Probe => {
  const errors: PeersError[] = []
  const call: PendingCall = {
    method: 'msg.send',
    params: { session_id: 'S1', client_msg_id: 'C1' },
    idempotent: true,
    internal: false,
    timeoutMs: 30_000,
    resolve: () => undefined,
    reject: (error) => errors.push(error),
    ...overrides,
  }
  return { call, errors }
}

describe('RetryQueue deadlines', () => {
  it('keeps the dedup window minus a safety margin', () => {
    expect(RETRY_WINDOW_MS).toBe(DEDUP_WINDOW_MS - DEDUP_SAFETY_MS)
  })

  it('times a queued call out after its own timeout, measured from enqueue', () => {
    const clock = new FakeClock()
    const queue = new RetryQueue(clock)
    const p = probe()
    queue.push(p.call)
    clock.advance(29_999)
    expect(p.errors).toEqual([])
    clock.advance(1)
    expect(p.errors.map((e) => e.code)).toEqual(['timeout'])
    expect(queue.size).toBe(0)
    expect(queue.take()).toEqual([])
  })

  it('never waits past the dedup window counted from the first dispatch', () => {
    const clock = new FakeClock()
    clock.advance(DEDUP_WINDOW_MS)
    const queue = new RetryQueue(clock)
    const sentAt = clock.now()
    clock.advance(RETRY_WINDOW_MS - 1_000)
    const p = probe({ firstSentAt: sentAt, timeoutMs: 60_000 })
    queue.push(p.call)
    clock.advance(999)
    expect(p.errors).toEqual([])
    clock.advance(1)
    expect(p.errors.map((e) => e.code)).toEqual(['timeout'])
  })

  it('rejects a call already past the window instead of queueing it', () => {
    const clock = new FakeClock()
    const queue = new RetryQueue(clock)
    clock.advance(RETRY_WINDOW_MS + 1)
    const p = probe({ firstSentAt: 0 })
    queue.push(p.call)
    expect(p.errors.map((e) => e.code)).toEqual(['disconnected'])
    expect(queue.size).toBe(0)
  })

  it('take() hands back live calls and cancels their timers', () => {
    const clock = new FakeClock()
    const queue = new RetryQueue(clock)
    const p = probe({ firstSentAt: 0 })
    queue.push(p.call)
    expect(clock.pending).toBe(1)
    expect(queue.take()).toEqual([p.call])
    expect(clock.pending).toBe(0)
    expect(p.errors).toEqual([])
  })

  it('take() drops calls past the window even when their timer never fired', () => {
    let now = 0
    const stuck = { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined }
    const queue = new RetryQueue(stuck)
    const fresh = probe()
    const old = probe({ firstSentAt: 0 })
    queue.push(fresh.call)
    queue.push(old.call)
    now = RETRY_WINDOW_MS
    expect(queue.take()).toEqual([fresh.call])
    expect(old.errors.map((e) => e.code)).toEqual(['disconnected'])
    expect(fresh.errors).toEqual([])
  })

  it('remaps session ids and still times out the remapped call', () => {
    const clock = new FakeClock()
    const queue = new RetryQueue(clock)
    const p = probe()
    queue.push(p.call)
    queue.remapSession('S1', 'S1')
    queue.remapSession('S1', 'S2')
    queue.remapSession('other', 'S3')
    clock.advance(30_000)
    expect(p.errors.map((e) => e.code)).toEqual(['timeout'])
    const q = probe()
    queue.push(q.call)
    queue.remapSession('S1', 'S2')
    expect(queue.take().map((c) => (c.params as { session_id: string }).session_id)).toEqual(['S2'])
  })
})
