import { describe, expect, it } from 'bun:test'
import { AsksResponseSchema, MyRoomsResponseSchema, RoomDetailResponseSchema } from '@agent-peers/protocol'
import { cmid, makeHarness } from '../helpers/services'

function setup() {
  const h = makeHarness()
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

describe('dashboard queries', () => {
  it('lists my rooms with counts', () => {
    const { h, alice, bob, a, room } = setup()
    h.services.sending.send(a, {
      session_id: a,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q',
    })
    const carol = h.member('carol')
    h.services.knocks.knock(h.as(carol.id), room)
    const mine = MyRoomsResponseSchema.parse({ rooms: h.services.queries.myRooms(alice.id) }).rooms
    expect(mine[0]).toMatchObject({ role: 'owner', people: 2, agents: 2, open_asks: 1, pending_knocks: 1 })
    expect(h.services.queries.myRooms(bob.id)[0]).not.toHaveProperty('pending_knocks')
    expect(h.services.queries.me(alice.id)?.name).toBe('alice')
    expect(h.services.queries.me('nope')).toBeUndefined()
  })

  it('groups room members by person with owner extras', () => {
    const { h, alice, bob, room } = setup()
    const owner = RoomDetailResponseSchema.parse(h.services.queries.roomDetail(h.as(alice.id), room))
    expect(owner.people[0]?.is_me).toBe(true)
    expect(owner.invite?.state).toBe('active')
    expect(owner.join_prompt).toContain('team')
    expect(owner.knocks).toEqual([])
    const member = RoomDetailResponseSchema.parse(h.services.queries.roomDetail(h.as(bob.id), room))
    expect(member.my_role).toBe('member')
    expect(member.invite).toBeUndefined()
    expect(h.services.queries.roomDetail({ kind: 'admin' }, room).my_role).toBe('owner')
  })

  it('pages the Q&A feed with filters', () => {
    const { h, a, b, room, alice, bob } = setup()
    const q = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: 'q',
    })
    h.services.sending.send(b, {
      session_id: b,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['home'],
      text: 'q2',
    })
    h.services.asks.claim(b, q.id)
    h.services.sending.reply(b, {
      session_id: b,
      client_msg_id: cmid(),
      ask_id: q.id,
      text: 'a',
      state: 'answered',
    })
    const all = AsksResponseSchema.parse(h.services.queries.asksFeed(alice.id, 'all'))
    expect(all.asks).toHaveLength(2)
    expect(all.next_cursor).toBeNull()
    const mine = h.services.queries.asksFeed(alice.id, 'mine')
    expect(mine.asks.map((t) => t.question.text)).toEqual(['q'])
    expect(mine.asks[0]?.answer?.text).toBe('a')
    expect(mine.asks[0]?.to?.session_id).toBe(b)
    expect(h.services.queries.asksFeed(bob.id, 'to_me').asks.map((t) => t.question.text)).toEqual(['q'])
    expect(h.services.queries.asksFeed(h.member('nobody').id, 'all').asks).toEqual([])
  })
})
