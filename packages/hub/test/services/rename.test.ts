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
  const room = h.room(alice.id, 'team')
  const room2 = h.room(alice.id, 'other')
  h.grant(room, bob.id)
  h.grant(room2, bob.id)
  const a = h.open(alice.id, 'a1')
  h.join(a, room, 'home')
  const b = h.open(bob.id, 'b1')
  h.join(b, room, 'work')
  h.join(b, room2, 'work')
  return { h, a, b, room, room2, alice, bob }
}

describe('renaming (§2.2)', () => {
  it('renames the title: presence.changed to rooms, session.patched to the session', () => {
    const { h, a, b, bob } = setup()
    h.link.clear()
    const result = h.services.rename.rename(h.as(bob.id, b), b, { title: '调研 T3Code 项目' })
    expect(result).toEqual({ title: '调研 T3Code 项目', rooms: [] })
    expect(h.link.of(b, 'session.patched')[0]?.params.title).toBe('调研 T3Code 项目')
    expect(h.link.of(a, 'presence.changed')).toHaveLength(1)
  })

  it('renames a handle everywhere, moving asks and the cursor, logging the change', () => {
    const { h, a, b, room, room2, bob } = setup()
    const sent = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q',
    })
    const mine = h.services.sending.send(b, {
      session_id: b,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['home'],
      text: 'q2',
    })
    h.services.messages.ack(b, { session_id: b, room_id: room, seq: sent.seq })
    const result = h.services.rename.rename(h.as(bob.id, b), b, { handle: 'office' })
    expect(result.rooms.map((r) => [r.room_id, r.old, r.new])).toEqual([
      [room, 'work', 'office'],
      [room2, 'work', 'office'],
    ])
    expect(h.services.deps.repos.asks.byId(sent.id)?.to_handle).toBe('office')
    expect(h.services.deps.repos.asks.byId(mine.id)?.from_handle).toBe('office')
    expect(h.services.deps.repos.cursors.get(room, 'office')).toBe(sent.seq)
    expect(h.link.of(b, 'handle.renamed')).toHaveLength(2)
    const system = h.link.of(a, 'msg.new').map((n) => (n.params.message as { text: string }).text)
    expect(system).toContain('@work is now @office')
    expect(h.services.deps.repos.messages.byId(sent.id)?.to_json).toBe('["work"]')
  })

  it('rejects conflicts atomically', () => {
    const { h, b, room, room2, bob, alice } = setup()
    const a2 = h.open(alice.id, 'a2')
    h.join(a2, room2, 'office')
    expect(code(() => h.services.rename.rename(h.as(bob.id, b), b, { handle: 'office' }))).toBe(
      'rename_conflict',
    )
    expect(h.services.deps.repos.handles.get(room, 'work')?.session_id).toBe(b)
    expect(
      h.services.rename.rename(h.as(bob.id, b), b, { handle: 'office', room_id: room }).rooms,
    ).toHaveLength(1)
  })

  it('checks who may rename', () => {
    const { h, a, b, room, alice, bob } = setup()
    expect(code(() => h.services.rename.rename(h.as(alice.id, a), b, { title: 'x' }))).toBe('forbidden')
    expect(code(() => h.services.rename.rename(h.as(alice.id), b, { title: 'x' }))).toBe('forbidden')
    expect(h.services.rename.rename(h.as(bob.id), b, { title: 'mine' }).title).toBe('mine')
    expect(h.services.rename.renameHandle(h.as(alice.id), room, 'work', 'desk').new).toBe('desk')
    expect(h.link.of(b, 'handle.renamed').at(-1)?.params.by).toEqual({ member: 'alice' })
    expect(code(() => h.services.rename.renameHandle(h.as(bob.id), room, 'home', 'x'))).toBe('forbidden')
    expect(h.services.rename.renameHandle(h.as(bob.id), room, 'desk', 'desk').new).toBe('desk')
    expect(code(() => h.services.rename.renameHandle({ kind: 'admin' }, room, 'nope', 'x'))).toBe(
      'target_not_found',
    )
    expect(h.services.rename.renameHandle({ kind: 'admin' }, room, 'desk', 'bench').new).toBe('bench')
  })

  it('patches accepting from the dashboard', () => {
    const { h, b, bob, room } = setup()
    const card = h.services.rename.patch(h.as(bob.id), b, { accepting: false })
    expect(card.accepting).toBe(false)
    expect(h.link.of(b, 'session.patched')[0]?.params).toEqual({ accepting: false })
    const renamed = h.services.rename.patch(h.as(bob.id), b, { title: 'T', handle: 'zz', room_id: room })
    expect(renamed.title).toBe('T')
    expect(renamed.rooms.find((r) => r.room_id === room)?.handle).toBe('zz')
  })
})
