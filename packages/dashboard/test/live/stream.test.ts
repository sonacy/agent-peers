import { beforeEach, describe, expect, it } from 'bun:test'
import { backoffDelay } from '../../src/live/backoff'
import { parseEvent } from '../../src/live/events'
import { browserEventSource, connectMemberEvents, type LiveStatus, type Timers } from '../../src/live/stream'
import { createFakeSource, FakeEventSource } from '../helpers/fake-hub'
import { card } from '../helpers/fixtures'

function fakeTimers() {
  let now = 1_000_000
  let pending: { fn: () => void; at: number; id: number }[] = []
  let ids = 0
  const timers: Timers = {
    set: (fn, ms) => {
      ids += 1
      pending = [...pending, { fn, at: now + ms, id: ids }]
      return ids
    },
    clear: (id) => {
      pending = pending.filter((p) => p.id !== id)
    },
    now: () => now,
  }
  const advance = (ms: number) => {
    now += ms
    const due = pending.filter((p) => p.at <= now)
    pending = pending.filter((p) => p.at > now)
    for (const p of due) p.fn()
  }
  return { timers, advance, pending: () => pending.length }
}

function start(timers: Timers) {
  const statuses: LiveStatus[] = []
  const events: unknown[] = []
  let resyncs = 0
  const handle = connectMemberEvents({
    createSource: createFakeSource,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onResync: () => {
      resyncs += 1
    },
    timers,
  })
  return { handle, statuses, events, resyncs: () => resyncs, last: () => statuses.at(-1) }
}

beforeEach(() => FakeEventSource.reset())

describe('backoffDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map((n) => backoffDelay(n))).toEqual([
      1000, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ])
  })
})

describe('parseEvent', () => {
  it('validates names and payloads', () => {
    expect(parseEvent('session', JSON.stringify({ session: card() }))?.name).toBe('session')
    expect(parseEvent('nope', '{}')).toBeUndefined()
    expect(parseEvent('session', '{bad')).toBeUndefined()
    expect(parseEvent('session', '{}')).toBeUndefined()
  })
})

describe('connectMemberEvents', () => {
  it('opens /v0/me/events, reports connected and forwards valid events only', () => {
    const { timers } = fakeTimers()
    const live = start(timers)
    const source = FakeEventSource.latest()
    expect(source.url).toBe('/v0/me/events')
    source.open()
    expect(live.last()?.state).toBe('connected')
    source.emit('session', { session: card() })
    source.emit('session', { nope: true })
    source.emit('knock', 'not json')
    expect(live.events).toHaveLength(1)
    expect(live.resyncs()).toBe(0)
  })
  it('backs off 1s → 2s → 4s, turns red on the second failure and resyncs on recovery', () => {
    const t = fakeTimers()
    const live = start(t.timers)
    FakeEventSource.latest().open()
    FakeEventSource.latest().fail()
    expect(FakeEventSource.latest().closed).toBe(true)
    expect(live.last()).toMatchObject({ state: 'reconnecting', failures: 1, nextRetryAt: 1_001_000 })
    t.advance(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
    FakeEventSource.latest().fail()
    expect(live.last()).toMatchObject({ state: 'disconnected', failures: 2, nextRetryAt: 1_003_000 })
    expect(live.last()?.lastError).toContain('事件流断开了')
    t.advance(2000)
    FakeEventSource.latest().fail()
    expect(live.last()?.nextRetryAt).toBe(1_003_000 + 4000)
    t.advance(4000)
    FakeEventSource.latest().open()
    expect(live.last()).toEqual({ state: 'connected', failures: 0 })
    expect(live.resyncs()).toBe(1)
  })
  it('retries now on demand and ignores retry while a source is open', () => {
    const t = fakeTimers()
    const live = start(t.timers)
    live.handle.retryNow()
    expect(FakeEventSource.instances).toHaveLength(1)
    FakeEventSource.latest().fail()
    FakeEventSource.instances[0]?.fail()
    expect(t.pending()).toBe(1)
    live.handle.retryNow()
    expect(t.pending()).toBe(0)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(live.last()?.state).toBe('reconnecting')
  })
  it('treats a throwing constructor as a failure and stops after close', () => {
    const t = fakeTimers()
    const statuses: LiveStatus[] = []
    let attempts = 0
    const handle = connectMemberEvents({
      createSource: () => {
        attempts += 1
        throw new Error('blocked')
      },
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      timers: t.timers,
    })
    expect(statuses.at(-1)?.failures).toBe(1)
    handle.close()
    t.advance(60_000)
    expect(attempts).toBe(1)
    handle.retryNow()
    expect(attempts).toBe(1)
  })
  it('closes the open source and drops later events', () => {
    const t = fakeTimers()
    const live = start(t.timers)
    const source = FakeEventSource.latest()
    live.handle.close()
    expect(source.closed).toBe(true)
    source.emit('session', { session: card() })
    expect(live.events).toHaveLength(0)
  })
  it('uses real timers and the browser EventSource by default', () => {
    expect(typeof browserEventSource()).toBe(typeof EventSource === 'undefined' ? 'undefined' : 'function')
    const handle = connectMemberEvents({
      createSource: createFakeSource,
      onEvent: () => {},
      onStatus: () => {},
    })
    FakeEventSource.latest().fail()
    handle.close()
  })
})
