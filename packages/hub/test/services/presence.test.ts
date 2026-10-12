import { describe, expect, it } from 'bun:test'
import { makeHarness } from '../helpers/services'

function setup(overrides = {}) {
  const h = makeHarness({ graceMs: 1000, ...overrides })
  const alice = h.member('alice')
  const bob = h.member('bob')
  const room = h.room(alice.id, 'team')
  h.grant(room, bob.id)
  const a = h.open(alice.id, 'a1')
  h.join(a, room, 'home')
  const b = h.open(bob.id, 'b1')
  h.join(b, room, 'work')
  return { h, a, b, room, alice, bob }
}

const connection = (h: ReturnType<typeof makeHarness>, id: string) =>
  h.services.deps.repos.sessions.byId(id)?.connection

describe('presence (§5)', () => {
  it('goes stale at once and offline after grace_ms, announcing only offline', () => {
    const { h, a, b } = setup()
    h.link.clear()
    h.services.presence.stale([b])
    expect(connection(h, b)).toBe('stale')
    expect(h.link.of(a, 'presence.changed')).toHaveLength(0)
    expect(h.services.presence.pendingOffline()).toBe(1)
    h.clock.advance(1000)
    expect(connection(h, b)).toBe('offline')
    const changed = h.link.of(a, 'presence.changed')
    expect((changed.at(-1)?.params.card as { connection: string } | undefined)?.connection).toBe('offline')
  })

  it('makes a reattach within grace_ms invisible', () => {
    const { h, a, b } = setup()
    h.services.presence.stale([b])
    h.clock.advance(500)
    h.link.clear()
    expect(h.services.presence.revive([b])).toEqual([])
    h.clock.advance(1000)
    expect(connection(h, b)).toBe('online')
    expect(h.link.of(a, 'presence.changed')).toHaveLength(0)
  })

  it('announces a revive after the session went offline', () => {
    const { h, a, b } = setup()
    h.services.presence.offline(b)
    h.link.clear()
    expect(h.services.presence.revive([b])).toEqual([b])
    expect(h.link.of(a, 'presence.changed')).toHaveLength(1)
    h.services.presence.stale(['nope'])
  })

  it('coalesces activity fan-out to once per second', () => {
    const { h, a, b } = setup()
    h.clock.advance(2000)
    h.link.clear()
    h.services.sessions.update(b, { activity: 'busy' })
    h.services.sessions.update(b, { activity: 'idle' })
    h.services.sessions.update(b, { activity: 'busy' })
    expect(h.link.of(a, 'presence.changed')).toHaveLength(1)
    h.clock.advance(1000)
    const changed = h.link.of(a, 'presence.changed')
    expect(changed).toHaveLength(2)
    expect((changed[1]?.params.card as { activity: string } | undefined)?.activity).toBe('busy')
    expect(h.events.some((e) => e.name === 'presence')).toBe(true)
  })

  it('closes idle sessions that are not online (backstop)', () => {
    const { h, b } = setup({ idleCloseMs: 5000 })
    h.services.presence.offline(b)
    h.clock.advance(6000)
    expect(h.services.sweeper.sweep().idleClosed).toBe(1)
    expect(h.services.deps.repos.sessions.byId(b)?.closed_at).not.toBeNull()
  })

  it('stops pending timers', () => {
    const { h, b } = setup()
    h.services.presence.stale([b])
    h.services.sessions.update(b, { activity: 'busy' })
    h.services.sessions.update(b, { activity: 'idle' })
    h.services.presence.stop()
    expect(h.services.presence.pendingOffline()).toBe(0)
  })

  it('counts grace from the first stale transition, not from a later close', () => {
    const { h, b } = setup()
    h.services.presence.stale([b])
    h.clock.advance(600)
    h.services.presence.stale([b])
    h.clock.advance(400)
    expect(connection(h, b)).toBe('offline')
  })

  it('recovers sessions left online by a previous run: stale, then offline with asks handled', () => {
    const { h, a, b, room } = setup()
    const working = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: 'r-1',
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q1',
    })
    const delivered = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: 'r-2',
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q2',
    })
    h.services.asks.claim(b, working.id)
    h.services.sessions.close(a)
    expect([...h.services.presence.recover()]).toEqual([b])
    expect(connection(h, b)).toBe('stale')
    h.clock.advance(1000)
    expect(connection(h, b)).toBe('offline')
    const ask = (id: string) => h.services.deps.repos.asks.byId(id)
    expect(ask(working.id)).toMatchObject({ state: 'failed', reason: 'target_lost' })
    expect(ask(delivered.id)?.state).toBe('queued')
  })

  it('prunes fan-out bookkeeping once it no longer throttles', () => {
    const { h, b } = setup()
    expect(h.services.presence.trackedFanouts()).toBeGreaterThan(0)
    h.clock.advance(2000)
    h.services.sessions.update(b, { activity: 'busy' })
    h.services.sessions.update(b, { activity: 'idle' })
    expect(h.services.presence.prune()).toBeGreaterThan(0)
    const pending = h.services.presence.trackedFanouts()
    expect(pending).toBe(1)
    h.clock.advance(2000)
    h.services.sweeper.sweep()
    expect(h.services.presence.trackedFanouts()).toBe(0)
  })

  it('logs a failing timer instead of throwing out of it', () => {
    const errors: string[] = []
    const logger = { info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) }
    const { h, b } = setup({ logger })
    h.services.presence.stale([b])
    h.services.deps.db.close()
    expect(() => h.clock.advance(1000)).not.toThrow()
    expect(errors).toEqual(['presence offline failed'])
  })
})
