import { describe, expect, it } from 'bun:test'
import { isPeersError, parseResult } from '@agent-peers/protocol'
import { makeHarness } from '../helpers/services'

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
  return 'ok'
}

describe('rooms', () => {
  it('creates a room with an owner grant, an invite and a joined handle', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const s = h.open(alice.id, 'a1')
    const created = h.services.rooms.create(h.as(alice.id, s), {
      name: 'team',
      description: 'payments',
      handle: 'home',
    })
    expect(created.handle).toBe('home')
    expect(created.rendered?.invite_url).toMatch(/^http:\/\/127\.0\.0\.1:7337\/j\/[0-9A-Z]{16}$/)
    expect(created.rendered?.loopback).toBe(true)
    expect(h.services.deps.repos.grants.get(created.room_id, alice.id)?.role).toBe('owner')
    expect(code(() => h.services.rooms.create(h.as(alice.id), { name: 'team' }))).toBe('invalid_name')
    expect(h.events.some((e) => e.name === 'room' && e.data.change === 'created')).toBe(true)
  })

  it('refuses member room creation when disabled or without a public URL', () => {
    const h = makeHarness({ allowRoomCreation: false })
    const alice = h.member('alice')
    expect(code(() => h.services.rooms.create(h.as(alice.id), { name: 'x' }))).toBe('forbidden')
    expect(h.services.rooms.create({ kind: 'admin' }, { name: 'ops' }).handle).toBeUndefined()
    const h2 = makeHarness()
    h2.services.deps.runtime.publicUrl = undefined
    const bob = h2.member('bob')
    expect(code(() => h2.services.rooms.create(h2.as(bob.id), { name: 'x' }))).toBe('forbidden')
  })

  it('joins by room_id, room_name or invite_code and needs a grant', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const bob = h.member('bob')
    const created = h.services.rooms.create(h.as(alice.id), { name: 'team' })
    const s = h.open(bob.id, 'b1')
    expect(code(() => h.services.rooms.join(s, { session_id: s, room_id: created.room_id }))).toBe(
      'forbidden',
    )
    expect(code(() => h.services.rooms.join(s, { session_id: s, room_name: 'nope' }))).toBe('room_not_found')
    const inviteCode = created.rendered?.invite_url.split('/').at(-1) ?? ''
    const joined = h.services.rooms.join(s, {
      session_id: s,
      invite_code: inviteCode.toLowerCase(),
      handle: 'work',
    })
    expect(joined.handle).toBe('work')
    expect(parseResult('room.join', joined).members.map((m) => m.handle)).toEqual(['work'])
    const s2 = h.open(bob.id, 'b2')
    expect(h.services.rooms.join(s2, { session_id: s2, room_name: 'team', handle: 'laptop' }).handle).toBe(
      'laptop',
    )
    expect(h.services.rooms.join(s2, { session_id: s2, room_id: created.room_id }).handle).toBe('laptop')
  })

  it('leaves, lists and lists peers', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const room = h.room(alice.id, 'team')
    const s = h.open(alice.id, 'a1')
    h.join(s, room, 'home')
    expect(h.services.rooms.list(s)).toEqual([
      expect.objectContaining({ room_id: room, handle: 'home', unread: 0 }),
    ])
    expect(h.services.rooms.peers(s).map((p) => p.handle)).toEqual(['home'])
    expect(h.services.rooms.peers(s, room)).toHaveLength(1)
    h.services.rooms.leave(s, room)
    expect(h.services.rooms.list(s)).toEqual([])
    expect(code(() => h.services.rooms.peers(s, room))).toBe('forbidden')
  })

  it('searches discoverable rooms with my_state', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const bob = h.member('bob')
    const open = h.room(alice.id, 'api-team')
    h.room(alice.id, 'api-secret', false)
    const mine = h.room(bob.id, 'api-bob')
    h.services.knocks.knock(h.as(bob.id), open, 'hi')
    const results = h.services.rooms.search(bob.id, 'api')
    expect(results.map((r) => [r.name, r.my_state])).toEqual([
      ['api-bob', 'member'],
      ['api-team', 'knocking'],
    ])
    expect(h.services.rooms.search(bob.id, 'alice').map((r) => r.owner)).toEqual(['alice'])
    expect(mine).toBeTruthy()
  })
})
