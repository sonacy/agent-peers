import { describe, expect, it } from 'bun:test'
import { cmid, makeHarness } from '../helpers/services'

function setup() {
  const h = makeHarness()
  const alice = h.member('alice')
  const bob = h.member('bob')
  const room = h.room(alice.id, 'team')
  h.grant(room, bob.id)
  return { h, alice, bob, room }
}

describe('session lifecycle (§4)', () => {
  it('reattaches by identity tuple with the same session_id', () => {
    const { h, alice } = setup()
    const s1 = h.open(alice.id, 'k1', { title: 'first' })
    const s2 = h.open(alice.id, 'k1', { summary: 'again' })
    expect(s2).toBe(s1)
    const card = h.services.cards.byId(s1)
    expect(card?.title).toBe('first')
    expect(card?.summary).toBe('again')
    expect(card?.connection).toBe('online')
    expect(h.open(alice.id, 'k1', { host: 'other' })).not.toBe(s1)
  })

  it('revives a closed session and re-claims its handles', () => {
    const { h, alice, room } = setup()
    const s1 = h.open(alice.id, 'k1')
    h.join(s1, room, 'home')
    h.services.sessions.close(s1)
    expect(h.services.cards.byId(s1)?.connection).toBe('offline')
    expect(h.link.detached).toContain(s1)
    const result = h.services.sessions.open(
      { memberId: alice.id, outdated: false },
      { local_key: 'k1', card: { agent: { kind: 'claude-code' }, host: 'laptop' } },
    )
    expect(result.session_id).toBe(s1)
    expect(result.rooms).toEqual([
      expect.objectContaining({ room_id: room, handle: 'home', status: 'joined' }),
    ])
  })

  it('reports a room as held when a live session of the member holds the handle', () => {
    const { h, alice, room } = setup()
    const s1 = h.open(alice.id, 'k1')
    h.join(s1, room, 'home')
    const s2 = h.open(alice.id, 'k2')
    h.join(s2, room, 'home', true)
    h.services.deps.repos.sessionRooms.upsert(s1, room, 'home')
    h.services.sessions.close(s1)
    const result = h.services.sessions.open(
      { memberId: alice.id, outdated: false },
      { local_key: 'k1', card: { agent: { kind: 'claude-code' }, host: 'laptop' } },
    )
    expect(result.rooms).toEqual([{ room_id: room, handle: 'home', status: 'held' }])
  })

  it('drops rooms whose grant is gone on revive', () => {
    const { h, bob, room, alice } = setup()
    const s = h.open(bob.id, 'k1')
    h.join(s, room, 'work')
    h.services.sessions.close(s)
    h.services.deps.repos.grants.revoke(room, bob.id, 1, false)
    expect(
      h.services.sessions.open(
        { memberId: bob.id, outdated: false },
        { local_key: 'k1', card: { agent: { kind: 'claude-code' }, host: 'laptop' } },
      ).rooms,
    ).toEqual([])
    expect(alice.id).toBeTruthy()
  })

  it('supersedes: handles and non-working asks move, working asks fail target_lost', () => {
    const { h, alice, bob, room } = setup()
    const asker = h.open(alice.id, 'a1')
    h.join(asker, room, 'home')
    const old = h.open(bob.id, 'old')
    h.join(old, room, 'work')
    const s = h.services.sending
    const q1 = s.send(asker, {
      session_id: asker,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'one',
    })
    const q2 = s.send(asker, {
      session_id: asker,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'two',
    })
    h.services.asks.claim(old, q1.id)
    const next = h.open(bob.id, 'new', {}, { supersedes: 'old' })
    expect(h.services.deps.repos.handles.get(room, 'work')?.session_id).toBe(next)
    expect(h.services.deps.repos.asks.byId(q1.id)?.state).toBe('failed')
    expect(h.services.deps.repos.asks.byId(q1.id)?.reason).toBe('target_lost')
    expect(h.services.deps.repos.asks.byId(q2.id)?.state).toBe('delivered')
    expect(h.services.deps.repos.sessions.byId(old)?.closed_at).not.toBeNull()
    expect(h.link.detached).toContain(old)
  })

  it('ignores supersedes of an unknown or identical key', () => {
    const { h, alice } = setup()
    const s = h.open(alice.id, 'k1', {}, { supersedes: 'nope' })
    expect(h.open(alice.id, 'k1', {}, { supersedes: 'k1' })).toBe(s)
  })

  it('updates the card and tracks activity changes', () => {
    const { h, alice, room } = setup()
    const s = h.open(alice.id, 'k1')
    h.join(s, room, 'home')
    h.clock.advance(5000)
    h.services.sessions.update(s, { activity: 'busy', summary: 'refactoring' })
    const card = h.services.cards.byId(s)
    expect(card?.activity).toBe('busy')
    expect(card?.summary).toBe('refactoring')
    expect(card?.last_activity_at).toBe(h.clock.now())
    h.clock.advance(5000)
    h.services.sessions.update(s, { summary: 'still' })
    expect(h.services.cards.byId(s)?.last_activity_at).toBe(h.clock.now() - 5000)
  })

  it('marks sessions on outdated bridges and lists them', () => {
    const { h, alice } = setup()
    const s = h.open(alice.id, 'k1', {}, { outdated: true })
    expect(h.services.cards.byId(s)?.outdated).toBe(true)
    expect(h.services.sessions.listOutdated().map((c) => c.session_id)).toEqual([s])
  })

  it('rejects unknown sessions', () => {
    const { h } = setup()
    expect(() => h.services.sessions.close('nope')).toThrow('unknown session')
  })
})
