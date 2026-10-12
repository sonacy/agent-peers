import { describe, expect, it } from 'bun:test'
import { isPeersError, KNOCK_EXPIRY_MS } from '@agent-peers/protocol'
import { makeHarness } from '../helpers/services'

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
  const room = h.room(alice.id, 'team')
  return { h, alice, bob, room }
}

describe('knocks (§10.2)', () => {
  it('knocks once, owner accepts, knocker sessions get knock.updated', () => {
    const { h, alice, bob, room } = setup()
    const s = h.open(bob.id, 'b1')
    const knock = h.services.knocks.knock(h.as(bob.id, s), room, 'please')
    expect(knock.state).toBe('pending')
    expect(code(() => h.services.knocks.knock(h.as(bob.id), room))).toBe('knock_pending')
    expect(h.services.knocks.pendingForRoom(h.as(alice.id), room)).toHaveLength(1)
    expect(h.services.knocks.pendingForMember(bob.id)).toHaveLength(1)
    expect(code(() => h.services.knocks.decide(h.as(bob.id), knock.knock_id, 'accept'))).toBe('forbidden')
    h.services.knocks.decide(h.as(alice.id), knock.knock_id, 'accept')
    expect(h.link.of(s, 'knock.updated')[0]?.params.state).toBe('accepted')
    expect(h.services.deps.repos.grants.get(room, bob.id)?.role).toBe('member')
    expect(code(() => h.services.knocks.knock(h.as(bob.id), room))).toBe('already_member')
    expect(code(() => h.services.knocks.decide(h.as(alice.id), knock.knock_id, 'decline'))).toBe(
      'invalid_params',
    )
  })

  it('waits 24 h after a decline', () => {
    const { h, alice, bob, room } = setup()
    const knock = h.services.knocks.knock(h.as(bob.id), room)
    h.services.knocks.decide(h.as(alice.id), knock.knock_id, 'decline')
    expect(code(() => h.services.knocks.knock(h.as(bob.id), room))).toBe('rate_limited')
    h.clock.advance(24 * 3600_000 + 1)
    expect(h.services.knocks.knock(h.as(bob.id), room).state).toBe('pending')
  })

  it('withdraws only by the knocker', () => {
    const { h, alice, bob, room } = setup()
    const knock = h.services.knocks.knock(h.as(bob.id), room)
    expect(code(() => h.services.knocks.withdraw(h.as(alice.id), knock.knock_id))).toBe('forbidden')
    h.services.knocks.withdraw(h.as(bob.id), knock.knock_id)
    expect(h.services.deps.repos.knocks.byId(knock.knock_id)?.state).toBe('withdrawn')
    expect(code(() => h.services.knocks.withdraw(h.as(bob.id), 'nope'))).toBe('invalid_params')
  })

  it('hides non-discoverable rooms and refuses the operator', () => {
    const { h, alice, bob } = setup()
    const hidden = h.room(alice.id, 'hidden', false)
    expect(code(() => h.services.knocks.knock(h.as(bob.id), hidden))).toBe('room_not_found')
    expect(code(() => h.services.knocks.knock({ kind: 'admin' }, hidden))).toBe('forbidden')
  })

  it('marks previously removed knockers and expires knocks after 7 days', () => {
    const { h, alice, bob, room } = setup()
    h.grant(room, bob.id)
    h.services.membership.kick(h.as(alice.id), room, 'bob')
    const knock = h.services.knocks.knock(h.as(bob.id), room)
    expect(knock.previously_removed).toBe(true)
    h.clock.advance(KNOCK_EXPIRY_MS)
    expect(h.services.sweeper.sweep().expiredKnocks).toBe(1)
    expect(h.services.deps.repos.knocks.byId(knock.knock_id)?.state).toBe('expired')
  })
})
