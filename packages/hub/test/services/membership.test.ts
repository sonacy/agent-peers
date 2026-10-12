import { describe, expect, it } from 'bun:test'
import { isPeersError } from '@agent-peers/protocol'
import { cmid, makeHarness } from '../helpers/services'

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
  return 'ok'
}

function setup() {
  const h = makeHarness()
  const alice = h.member('alice')
  const bob = h.member('bob')
  const created = h.services.rooms.create(h.as(alice.id), { name: 'team' })
  const room = created.room_id
  const inviteCode = created.rendered?.invite_url.split('/').at(-1) ?? ''
  h.grant(room, bob.id)
  const a = h.open(alice.id, 'a1')
  h.join(a, room, 'home')
  const b = h.open(bob.id, 'b1')
  h.join(b, room, 'work')
  return { h, alice, bob, room, a, b, inviteCode }
}

describe('removing agents and people (§10.3)', () => {
  it('removes a session (own member or owner) and keeps the grant', () => {
    const { h, alice, bob, room, a, b } = setup()
    expect(code(() => h.services.membership.removeSession(h.as(bob.id), room, a))).toBe('forbidden')
    h.services.membership.removeSession(h.as(alice.id), room, b)
    expect(h.link.of(b, 'room.removed')[0]?.params.reason).toBe('removed')
    expect(h.services.deps.repos.grants.get(room, bob.id)?.revoked_at).toBeNull()
    expect(code(() => h.services.membership.removeSession(h.as(alice.id), room, b))).toBe('target_not_found')
    expect(code(() => h.services.membership.removeSession(h.as(alice.id), room, 'nope'))).toBe(
      'target_not_found',
    )
  })

  it('exits a room unless owner', () => {
    const { h, alice, bob, room, b } = setup()
    expect(code(() => h.services.membership.exit(h.as(alice.id), room))).toBe('forbidden')
    expect(code(() => h.services.membership.exit({ kind: 'admin' }, room))).toBe('forbidden')
    h.services.membership.exit(h.as(bob.id), room)
    expect(h.link.of(b, 'room.removed')[0]?.params.reason).toBe('removed')
    expect(h.services.deps.repos.grants.get(room, bob.id)?.revoked_at).not.toBeNull()
  })

  it('kicks: revokes, notifies, lists, blocks the old invite, restores', () => {
    const { h, alice, bob, room, a, b, inviteCode } = setup()
    const sent = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q',
    })
    expect(code(() => h.services.membership.kick(h.as(bob.id), room, 'alice'))).toBe('forbidden')
    expect(code(() => h.services.membership.kick(h.as(alice.id), room, 'alice'))).toBe('forbidden')
    expect(code(() => h.services.membership.kick(h.as(alice.id), room, 'nobody'))).toBe('target_not_found')
    h.services.membership.kick(h.as(alice.id), room, 'bob')
    expect(h.link.of(b, 'room.removed')[0]?.params.reason).toBe('kicked')
    expect(h.link.of(b, 'kicked')).toHaveLength(1)
    expect(h.services.deps.repos.asks.byId(sent.id)?.reason).toBe('not_in_room')
    expect(h.services.membership.kicked(h.as(alice.id), room).map((k) => k.member)).toEqual(['bob'])
    const b2 = h.open(bob.id, 'b2')
    expect(code(() => h.services.rooms.join(b2, { session_id: b2, room_id: room }))).toBe('forbidden')
    // The kick rotated the invite: the code bob knows is dead, for him and for a fresh identity.
    expect(code(() => h.services.rooms.join(b2, { session_id: b2, invite_code: inviteCode }))).toBe(
      'invite_invalid',
    )
    expect(code(() => h.services.members.redeemAsNew(inviteCode, 'bob2'))).toBe('invite_invalid')
    expect(h.events.some((e) => e.name === 'room' && e.data.change === 'invite')).toBe(true)
    const rotated = h.services.invites.reopen(h.as(alice.id), room)
    const rotatedCode = rotated.invite_url?.split('/').at(-1) ?? ''
    expect(rotatedCode).not.toBe(inviteCode)
    // An invite minted in the same millisecond as the kick still doesn't let the kicked member in.
    expect(code(() => h.services.rooms.join(b2, { session_id: b2, invite_code: rotatedCode }))).toBe(
      'forbidden',
    )
    h.clock.advance(1)
    const fresh = h.services.invites.rotate(h.as(alice.id), room)
    const freshCode = fresh.invite_url?.split('/').at(-1) ?? ''
    expect(h.services.rooms.join(b2, { session_id: b2, invite_code: freshCode, handle: 'work' }).handle).toBe(
      'work',
    )
    h.services.membership.kick(h.as(alice.id), room, 'bob')
    h.services.membership.restore(h.as(alice.id), room, 'bob')
    expect(h.services.deps.repos.grants.get(room, bob.id)?.role).toBe('member')
    expect(code(() => h.services.membership.restore(h.as(alice.id), room, 'bob'))).toBe('target_not_found')
  })

  it('dissolves: everyone removed, invite closed, knocks dropped, asks failed', () => {
    const { h, alice, bob, room, a, b } = setup()
    const carol = h.member('carol')
    h.services.knocks.knock(h.as(carol.id), room)
    const sent = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q',
    })
    expect(code(() => h.services.membership.dissolve(h.as(bob.id), room))).toBe('forbidden')
    h.services.membership.dissolve(h.as(alice.id), room)
    expect(h.link.of(a, 'room.removed')[0]?.params.reason).toBe('dissolved')
    expect(h.link.of(b, 'room.removed')[0]?.params.reason).toBe('dissolved')
    expect(h.services.deps.repos.invites.active(room)).toBeUndefined()
    expect(h.services.deps.repos.knocks.pendingForRoom(room)).toHaveLength(0)
    expect(h.services.deps.repos.asks.byId(sent.id)?.state).toBe('failed')
    expect(h.services.deps.repos.messages.byId(sent.id)).toBeDefined()
    expect(code(() => h.services.access.requireRoom(room))).toBe('room_not_found')
    expect(h.events.some((e) => e.name === 'room' && e.data.change === 'dissolved')).toBe(true)
  })
})
