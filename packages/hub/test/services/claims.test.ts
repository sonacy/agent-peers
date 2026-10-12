import { describe, expect, it } from 'bun:test'
import { isPeersError } from '@agent-peers/protocol'
import { makeHarness } from '../helpers/services'

function setup() {
  const h = makeHarness()
  const alice = h.member('alice')
  const bob = h.member('bob')
  const room = h.room(alice.id, 'team')
  h.grant(room, bob.id)
  return { h, alice, bob, room }
}

describe('claiming a handle (§2.1)', () => {
  it('claims a free handle and starts the cursor at the room head', () => {
    const { h, alice, room } = setup()
    const s = h.open(alice.id, 'a1')
    expect(h.join(s, room, 'home')).toBe('home')
    const head = h.services.deps.repos.rooms.byId(room)?.head_seq
    expect(h.services.deps.repos.cursors.get(room, 'home')).toBe(head)
  })

  it('announces a join to the room but not to the joiner, who must see replay.done first (§6.3)', () => {
    const { h, alice, bob, room } = setup()
    const a = h.open(alice.id, 'a1')
    h.join(a, room, 'home')
    const b = h.open(bob.id, 'b1')
    h.link.clear()
    h.join(b, room, 'work')
    const text = (n: { params: Record<string, unknown> }) => (n.params.message as { text: string }).text
    expect(h.link.of(a, 'msg.new').map(text)).toEqual(['@work joined'])
    expect(h.link.of(b, 'msg.new')).toEqual([])
    const head = h.services.deps.repos.rooms.byId(room)?.head_seq
    expect(h.services.deps.repos.cursors.get(room, 'work')).toBe(head)
  })

  it('refuses a handle held by another member and suggests name-2', () => {
    const { h, alice, bob, room } = setup()
    h.join(h.open(alice.id, 'a1'), room, 'home')
    const s = h.open(bob.id, 'b1')
    try {
      h.join(s, room, 'home')
      throw new Error('expected handle_taken')
    } catch (error) {
      expect(isPeersError(error, 'handle_taken')).toBe(true)
      expect((error as { data?: { suggestion?: string } }).data?.suggestion).toBe('home-2')
      expect((error as { data?: { same_member?: boolean } }).data?.same_member).toBe(false)
    }
  })

  it('lets the same member claim from an offline or stale holder', () => {
    const { h, alice, room } = setup()
    const s1 = h.open(alice.id, 'a1')
    h.join(s1, room, 'home')
    h.services.sessions.close(s1)
    const s2 = h.open(alice.id, 'a2')
    expect(h.join(s2, room, 'home')).toBe('home')
    expect(h.services.deps.repos.handles.get(room, 'home')?.session_id).toBe(s2)
    h.services.presence.stale([s2])
    const s3 = h.open(alice.id, 'a3')
    expect(h.join(s3, room, 'home')).toBe('home')
  })

  it('needs takeover against an online holder of the same member, which gets handle.lost', () => {
    const { h, alice, room } = setup()
    const s1 = h.open(alice.id, 'a1')
    h.join(s1, room, 'home')
    const s2 = h.open(alice.id, 'a2')
    expect(() => h.join(s2, room, 'home')).toThrow('taken')
    try {
      h.join(s2, room, 'home')
    } catch (error) {
      expect((error as { data?: { same_member?: boolean } }).data?.same_member).toBe(true)
    }
    expect(h.join(s2, room, 'home', true)).toBe('home')
    const lost = h.link.of(s1, 'handle.lost')
    expect(lost).toHaveLength(1)
    expect(lost[0]?.params.handle).toBe('home')
    expect(h.services.deps.repos.sessionRooms.forSession(s1)).toHaveLength(0)
  })

  it('keeps the existing handle when a joined session joins again', () => {
    const { h, alice, room } = setup()
    const s1 = h.open(alice.id, 'a1')
    h.join(s1, room, 'home')
    expect(h.join(s1, room, 'other')).toBe('home')
  })

  it('derives a default handle from the host and suffixes it on conflict', () => {
    const { h, alice, bob, room } = setup()
    const a = h.open(alice.id, 'a1', { host: 'gulei-mbp.local' })
    expect(h.join(a, room)).toBe('gulei-mbp')
    const b = h.open(bob.id, 'b1', { host: 'gulei-mbp' })
    expect(h.join(b, room)).toBe('gulei-mbp-2')
  })

  it('falls back to the member name when host and workspace are unusable', () => {
    const { h, alice, room } = setup()
    const s = h.open(alice.id, 'a1', { host: '___' })
    expect(h.join(s, room)).toMatch(/^agent-|^alice$/)
  })
})
