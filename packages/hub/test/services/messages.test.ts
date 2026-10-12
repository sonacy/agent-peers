import { describe, expect, it } from 'bun:test'
import { isPeersError, REPLAY_LIMIT } from '@agent-peers/protocol'
import { cmid, makeHarness } from '../helpers/services'

function setup(overrides = {}) {
  const h = makeHarness(overrides)
  const alice = h.member('alice')
  const bob = h.member('bob')
  const room = h.room(alice.id, 'team')
  h.grant(room, bob.id)
  const a = h.open(alice.id, 'a1')
  h.join(a, room, 'home')
  const b = h.open(bob.id, 'b1')
  h.join(b, room, 'work')
  const chat = (text: string, id = cmid(), session = a) =>
    h.services.sending.send(session, {
      session_id: session,
      client_msg_id: id,
      room_id: room,
      kind: 'chat',
      text,
    })
  return { h, room, a, b, chat, alice, bob }
}

describe('messages (§6.1, §6.3, §6.4)', () => {
  it('assigns a gap-free seq and fans out to everyone but the sender', () => {
    const { h, a, b, chat } = setup()
    const first = chat('one')
    const second = chat('two')
    expect(second.seq).toBe(first.seq + 1)
    expect(h.link.of(b, 'msg.new').map((n) => (n.params.message as { text: string }).text)).toContain('two')
    expect(h.link.of(a, 'msg.new').some((n) => (n.params.message as { text: string }).text === 'two')).toBe(
      false,
    )
  })

  it('dedupes on client_msg_id for ten minutes', () => {
    const { h, chat } = setup()
    const first = chat('one', 'same')
    expect(chat('changed', 'same')).toEqual(first)
    h.clock.advance(10 * 60_000 + 1)
    expect(chat('again', 'same').seq).toBeGreaterThan(first.seq)
  })

  it('replays at most 50 messages above the cursor, then replay.done', () => {
    const { h, room, b, chat } = setup({ messagesPerMinute: 1000 })
    for (let i = 0; i < 60; i += 1) chat(`m${i}`)
    h.link.clear()
    h.services.messages.deliverRoom(b, room, 'work')
    const replayed = h.link.of(b, 'msg.new').filter((n) => n.params.replay)
    expect(replayed).toHaveLength(REPLAY_LIMIT)
    expect((replayed.at(-1)?.params.message as { text: string } | undefined)?.text).toBe('m59')
    const done = h.link.of(b, 'replay.done')
    expect(done[0]?.params.head_seq).toBe(h.services.deps.repos.rooms.byId(room)?.head_seq)
  })

  it('acks move the cursor forward only, capped at the head', () => {
    const { h, room, b, chat } = setup()
    const sent = chat('x')
    h.services.messages.ack(b, { session_id: b, room_id: room, seq: sent.seq })
    expect(h.services.deps.repos.cursors.get(room, 'work')).toBe(sent.seq)
    h.services.messages.ack(b, { session_id: b, room_id: room, seq: 1 })
    expect(h.services.deps.repos.cursors.get(room, 'work')).toBe(sent.seq)
    h.services.messages.ack(b, { session_id: b, room_id: room, seq: 9999 })
    expect(h.services.deps.repos.cursors.get(room, 'work')).toBe(sent.seq)
    chat('y')
    expect(h.services.rooms.list(b)[0]?.unread).toBe(1)
  })

  it('returns history before a seq for grant holders', () => {
    const { h, room, alice, chat } = setup()
    chat('one')
    const two = chat('two')
    chat('three')
    const page = h.services.messages.history(alice.id, { room_id: room, before_seq: two.seq + 1, limit: 2 })
    expect(page.messages.map((m) => m.text)).toEqual(['one', 'two'])
    const carol = h.member('carol')
    expect(() => h.services.messages.history(carol.id, { room_id: room })).toThrow()
    expect(h.services.messages.history(undefined, { room_id: room }).messages.length).toBeGreaterThan(3)
  })

  it('rate limits 30 messages per minute per member', () => {
    const { h, chat } = setup()
    for (let i = 0; i < 30; i += 1) chat(`m${i}`)
    try {
      chat('too many')
      throw new Error('expected rate_limited')
    } catch (error) {
      expect(isPeersError(error, 'rate_limited')).toBe(true)
      expect((error as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0)
    }
    h.clock.advance(60_001)
    expect(chat('ok').seq).toBeGreaterThan(0)
  })

  it('requires the sender to have joined the room', () => {
    const { h, room } = setup()
    const carol = h.member('carol')
    const c = h.open(carol.id, 'c1')
    expect(() =>
      h.services.sending.send(c, {
        session_id: c,
        client_msg_id: cmid(),
        room_id: room,
        kind: 'chat',
        text: 'x',
      }),
    ).toThrow('has not joined')
    expect(() =>
      h.services.sending.send(c, {
        session_id: c,
        client_msg_id: cmid(),
        room_id: 'nope',
        kind: 'chat',
        text: 'x',
      }),
    ).toThrow('room not found')
  })
})
