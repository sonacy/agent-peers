/**
 * Regression (found by the L2 integration suite): a same-member claim of an offline holder's handle
 * used to delete the holder's room intent, so a revived session silently lost the room instead of
 * reporting it `held` (§4) or re-claiming it once the new holder went offline (§2.1).
 */
import { describe, expect, it } from 'bun:test'
import { makeHarness } from '../helpers/services'

const reopen = (h: ReturnType<typeof makeHarness>, memberId: string, localKey: string) =>
  h.services.sessions.open(
    { memberId, outdated: false },
    { local_key: localKey, card: { agent: { kind: 'claude-code' }, host: 'laptop' } },
  )

describe('room intent across same-member handle claims (§2.1, §4)', () => {
  it('a revived session reports the room held while the new holder is online', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const room = h.room(alice.id, 'team')
    const s1 = h.open(alice.id, 'k1')
    h.join(s1, room, 'home')
    h.services.sessions.close(s1)
    const s2 = h.open(alice.id, 'k2')
    expect(h.join(s2, room, 'home')).toBe('home')

    expect(reopen(h, alice.id, 'k1').rooms).toEqual([{ room_id: room, handle: 'home', status: 'held' }])
    expect(h.services.deps.repos.handles.get(room, 'home')?.session_id).toBe(s2)
  })

  it('re-claims the handle on revive once the new holder is offline', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const room = h.room(alice.id, 'team')
    const s1 = h.open(alice.id, 'k1')
    h.join(s1, room, 'home')
    h.services.sessions.close(s1)
    const s2 = h.open(alice.id, 'k2')
    h.join(s2, room, 'home')
    h.services.sessions.close(s2)

    const revived = reopen(h, alice.id, 'k1')
    expect(revived.rooms).toEqual([
      expect.objectContaining({ room_id: room, handle: 'home', status: 'joined' }),
    ])
    expect(h.services.deps.repos.handles.get(room, 'home')?.session_id).toBe(s1)
  })

  it('an online holder displaced by takeover drops the room for good', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const room = h.room(alice.id, 'team')
    const s1 = h.open(alice.id, 'k1')
    h.join(s1, room, 'home')
    const s2 = h.open(alice.id, 'k2')
    h.join(s2, room, 'home', true)
    expect(h.link.of(s1, 'handle.lost')).toHaveLength(1)
    h.services.sessions.close(s1)

    expect(reopen(h, alice.id, 'k1').rooms).toEqual([])
  })

  it('a later release of the handle drops every session’s intent for it', () => {
    const h = makeHarness()
    const alice = h.member('alice')
    const room = h.room(alice.id, 'team')
    const s1 = h.open(alice.id, 'k1')
    h.join(s1, room, 'home')
    h.services.sessions.close(s1)
    const s2 = h.open(alice.id, 'k2')
    h.join(s2, room, 'home')
    h.services.rooms.leave(s2, room)

    expect(reopen(h, alice.id, 'k1').rooms).toEqual([])
  })
})
