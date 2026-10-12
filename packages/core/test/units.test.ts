import { describe, expect, it, mock } from 'bun:test'
import { PeersError } from '@agent-peers/protocol'
import { Heartbeat } from '../src/client/heartbeat'
import { InFlight } from '../src/client/inflight'
import { assertTransportAllowed, isPrivateHost, toWebSocketUrl } from '../src/client/url'
import { systemClock } from '../src/util/clock'
import { Emitter } from '../src/util/emitter'
import { FakeClock } from './helpers/fake-clock'

describe('Heartbeat', () => {
  it('pings only after intervalMs without a sent frame', () => {
    const clock = new FakeClock()
    const onPing = mock(() => undefined)
    const onDead = mock(() => undefined)
    const hb = new Heartbeat(clock, 100, { onPing, onDead })
    hb.start()
    clock.advance(60)
    hb.noteSent()
    hb.noteReceived()
    clock.advance(60)
    expect(onPing).toHaveBeenCalledTimes(0)
    clock.advance(40)
    expect(onPing).toHaveBeenCalledTimes(1)
    hb.noteReceived()
    clock.advance(100)
    expect(onPing).toHaveBeenCalledTimes(2)
    expect(onDead).toHaveBeenCalledTimes(0)
    hb.stop()
    expect(clock.pending).toBe(0)
  })

  it('received frames do not delay pings, and silence for 2x interval is death', () => {
    const clock = new FakeClock()
    const onPing = mock(() => undefined)
    const onDead = mock(() => undefined)
    const hb = new Heartbeat(clock, 100, { onPing, onDead })
    hb.start()
    clock.advance(90)
    hb.noteReceived()
    clock.advance(10)
    expect(onPing).toHaveBeenCalledTimes(1)
    clock.advance(189)
    expect(onDead).toHaveBeenCalledTimes(0)
    clock.advance(1)
    expect(onDead).toHaveBeenCalledTimes(1)
    expect(clock.pending).toBe(0)
  })
})

describe('InFlight', () => {
  it('times out, takes and drains', () => {
    const clock = new FakeClock()
    const inflight = new InFlight(clock)
    const rejected: string[] = []
    const call = (method: string) => ({
      method,
      params: {},
      idempotent: false,
      internal: false,
      timeoutMs: 50,
      resolve: () => undefined,
      reject: (e: PeersError) => rejected.push(`${method}:${e.code}`),
    })
    const a = inflight.add(call('a'))
    inflight.add(call('b'))
    inflight.add(call('c'))
    expect(inflight.take(a)?.method).toBe('a')
    expect(inflight.take(a)).toBeUndefined()
    expect(inflight.take('x')).toBeUndefined()
    expect(inflight.take(null)).toBeUndefined()
    clock.advance(50)
    expect(rejected).toEqual(['b:timeout', 'c:timeout'])
    inflight.add(call('d'))
    expect(inflight.drain().map((c) => c.method)).toEqual(['d'])
    expect(inflight.size).toBe(0)
    clock.advance(100)
    expect(rejected).toHaveLength(2)
  })
})

describe('url', () => {
  it('derives the ws endpoint', () => {
    expect(toWebSocketUrl('https://hub.example.com')).toBe('wss://hub.example.com/v0/ws')
    expect(toWebSocketUrl('http://127.0.0.1:7337/j/CODE')).toBe('ws://127.0.0.1:7337/v0/ws')
    expect(toWebSocketUrl('wss://hub.example.com/custom/ws')).toBe('wss://hub.example.com/custom/ws')
    expect(toWebSocketUrl('ws://10.0.0.2:7337')).toBe('ws://10.0.0.2:7337/v0/ws')
    expect(() => toWebSocketUrl('ftp://x')).toThrow(PeersError)
    expect(() => toWebSocketUrl('not a url')).toThrow(PeersError)
  })

  it('classifies private hosts', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '[::1]',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.9.9',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.255.1',
    ])
      expect(isPrivateHost(host)).toBe(true)
    for (const host of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'hub.example.com', '1.2.3', '300.1.1.1'])
      expect(isPrivateHost(host)).toBe(false)
  })

  it('enforces the transport rule', () => {
    expect(() => assertTransportAllowed('ws://8.8.8.8/v0/ws', false)).toThrow(PeersError)
    expect(() => assertTransportAllowed('ws://8.8.8.8/v0/ws', true)).not.toThrow()
    expect(() => assertTransportAllowed('wss://8.8.8.8/v0/ws', false)).not.toThrow()
    expect(() => assertTransportAllowed('ws://192.168.0.2/v0/ws', false)).not.toThrow()
  })
})

describe('small utilities', () => {
  it('emitter isolates listener errors and supports unsubscribe', () => {
    const errors: unknown[] = []
    const emitter = new Emitter<{ x: number }>((e) => errors.push(e))
    const got: number[] = []
    emitter.on('x', () => {
      throw new Error('bad')
    })
    const off = emitter.on('x', (n) => got.push(n))
    emitter.emit('x', 1)
    off()
    off()
    emitter.emit('x', 2)
    expect(got).toEqual([1])
    expect(errors).toHaveLength(2)
    expect(emitter.listenerCount('x')).toBe(1)
    emitter.clear()
    expect(emitter.listenerCount('x')).toBe(0)
  })

  it('system clock schedules and cancels', async () => {
    const fired = mock(() => undefined)
    const handle = systemClock.setTimeout(fired, 1)
    systemClock.clearTimeout(handle)
    await Bun.sleep(5)
    expect(fired).not.toHaveBeenCalled()
    expect(systemClock.now()).toBeGreaterThan(0)
  })
})
