import { describe, expect, it } from 'bun:test'
import { encodeResult, isPeersError, MAX_FRAME_BYTES, type Message } from '@agent-peers/protocol'
import { encodedSize, FRAME_BUDGET_BYTES, fitNewest } from '../../src/services/frame-budget'
import { cmid, makeHarness } from '../helpers/services'

const BIG = 'x'.repeat(60_000)

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
  const chat = (text: string) =>
    h.services.sending.send(a, { session_id: a, client_msg_id: cmid(), room_id: room, kind: 'chat', text })
  return { h, alice, room, a, b, chat }
}

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
  return 'ok'
}

const msg = (seq: number, text: string): Message =>
  ({ id: `m${seq}`, room_id: 'r', seq, kind: 'chat', text, ts: 1 }) as Message

describe('outbound frame budget (§1)', () => {
  it('keeps the newest messages that fit, oldest first, and always at least one', () => {
    const page = [msg(1, 'a'), msg(2, 'b'), msg(3, 'c')]
    expect(fitNewest(page)).toEqual({ messages: page, truncated: false })
    const two = encodedSize(page[1]) + encodedSize(page[2]) + 2
    expect(fitNewest(page, two)).toEqual({ messages: page.slice(1), truncated: true })
    expect(fitNewest(page, 1)).toEqual({ messages: page.slice(2), truncated: true })
    expect(fitNewest([])).toEqual({ messages: [], truncated: false })
  })

  it('cuts a msg.history page of large messages to one frame and lets the caller page on', () => {
    const { h, alice, room, chat } = setup()
    for (let i = 0; i < 6; i += 1) chat(`${i}:${BIG}`)
    const page = h.services.messages.history(alice.id, { room_id: room, limit: 10 })
    expect(page.truncated).toBe(true)
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.length).toBeLessThan(6)
    expect(page.messages.at(-1)?.text.startsWith('5:')).toBe(true)
    expect(() => encodeResult(1, { messages: page.messages, truncated: true })).not.toThrow()
    const older = h.services.messages.history(alice.id, {
      room_id: room,
      limit: 10,
      before_seq: page.messages[0]?.seq ?? 0,
    })
    expect(older.messages.at(-1)?.seq).toBe((page.messages[0]?.seq ?? 0) - 1)
  })

  it('keeps ask.get under one frame, dropping the oldest follow-ups', () => {
    const { h, alice, room, a, b } = setup()
    const sent = h.services.sending.send(a, {
      session_id: a,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text: BIG,
    })
    h.services.asks.claim(b, sent.id)
    for (let i = 0; i < 4; i += 1) {
      h.services.sending.progress(b, {
        session_id: b,
        client_msg_id: cmid(),
        ask_id: sent.id,
        text: `${i}:${BIG}`,
      })
    }
    h.services.sending.reply(b, {
      session_id: b,
      client_msg_id: cmid(),
      ask_id: sent.id,
      text: 'done',
      state: 'answered',
    })
    const got = h.services.asks.get(h.as(alice.id), sent.id)
    expect(got.truncated).toBe(true)
    expect(got.messages[0]?.id).toBe(sent.id)
    expect(got.messages.at(-1)?.text).toBe('done')
    expect(encodedSize(got)).toBeLessThanOrEqual(FRAME_BUDGET_BYTES)
    expect(() => encodeResult(1, got)).not.toThrow()
  })

  it('refuses to store a message whose encoding would not fit a notification frame', () => {
    const { h, room, chat } = setup()
    // 64 KiB of control characters is valid text but JSON-escapes to six times its size.
    const escaped = '\u0001'.repeat(64 * 1024)
    expect(encodedSize(escaped)).toBeGreaterThan(MAX_FRAME_BYTES)
    expect(code(() => chat(escaped))).toBe('payload_too_large')
    expect(h.services.deps.repos.rooms.byId(room)?.head_seq).toBe(
      h.services.messages.history(undefined, { room_id: room }).messages.at(-1)?.seq,
    )
    expect(code(() => chat('fits'))).toBe('ok')
  })
})
