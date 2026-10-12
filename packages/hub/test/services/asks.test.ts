import { describe, expect, it } from 'bun:test'
import { isPeersError } from '@agent-peers/protocol'
import { cmid, makeHarness } from '../helpers/services'

function setup() {
  const h = makeHarness()
  const alice = h.member('alice')
  const bob = h.member('bob')
  const room = h.room(alice.id, 'team')
  h.grant(room, bob.id)
  const asker = h.open(alice.id, 'a1')
  h.join(asker, room, 'home')
  const target = h.open(bob.id, 'b1')
  h.join(target, room, 'work')
  const ask = (text = 'q?', extra: Record<string, unknown> = {}) =>
    h.services.sending.send(asker, {
      session_id: asker,
      client_msg_id: cmid(),
      room_id: room,
      kind: 'ask',
      to: ['work'],
      text,
      ...extra,
    } as never)
  const state = (id: string) => h.services.deps.repos.asks.byId(id)
  return { h, alice, bob, room, asker, target, ask, state }
}

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
  return 'ok'
}

describe('asks (§6.2)', () => {
  it('delivers to a live target and queues for an offline one', () => {
    const { h, target, ask, state } = setup()
    const live = ask()
    expect(live.ask?.state).toBe('delivered')
    expect(
      h.link.of(target, 'msg.new').some((n) => (n.params.message as { id: string }).id === live.id),
    ).toBe(true)
    h.services.sessions.close(target)
    const queued = ask()
    expect(queued.ask?.state).toBe('queued')
    expect(state(live.id)?.state).toBe('queued')
  })

  it('claims with compare-and-set semantics', () => {
    const { h, bob, room, target, ask } = setup()
    const sent = ask()
    expect(h.services.asks.claim(target, sent.id).state).toBe('working')
    expect(h.services.asks.claim(target, sent.id).assignee_session).toBe(target)
    const other = h.open(bob.id, 'b2')
    expect(code(() => h.services.asks.claim(other, sent.id))).toBe('ask_taken')
    const second = ask()
    expect(code(() => h.services.asks.claim(other, second.id))).toBe('forbidden')
    expect(code(() => h.services.asks.claim(target, 'nope'))).toBe('target_not_found')
    h.services.asks.cancel({ kind: 'admin' }, second.id)
    expect(code(() => h.services.asks.claim(target, second.id))).toBe('ask_closed')
    expect(room).toBeTruthy()
  })

  it('lets only the assignee reply, then notifies the asker', () => {
    const { h, asker, target, ask, state } = setup()
    const sent = ask()
    const reply = {
      session_id: target,
      client_msg_id: cmid(),
      ask_id: sent.id,
      text: 'a',
      state: 'answered' as const,
    }
    expect(code(() => h.services.sending.reply(target, reply))).toBe('forbidden')
    h.services.asks.claim(target, sent.id)
    expect(code(() => h.services.sending.reply(asker, { ...reply, session_id: asker }))).toBe('forbidden')
    h.services.sending.progress(target, {
      session_id: target,
      client_msg_id: cmid(),
      ask_id: sent.id,
      text: 'working…',
    })
    const r = h.services.sending.reply(target, reply)
    expect(r.seq).toBeGreaterThan(sent.seq)
    expect(state(sent.id)?.state).toBe('answered')
    expect(h.link.of(asker, 'ask.updated').map((n) => n.params.state)).toEqual([
      'delivered',
      'working',
      'answered',
    ])
    expect(code(() => h.services.sending.reply(target, { ...reply, client_msg_id: cmid() }))).toBe(
      'ask_closed',
    )
    const got = h.services.asks.get(
      { kind: 'member', memberId: h.services.deps.repos.sessions.byId(asker)?.member_id ?? '' },
      sent.id,
    )
    expect(got.messages.map((m) => m.kind)).toEqual(['ask', 'progress', 'reply'])
  })

  it('maps a failed reply to no_reply', () => {
    const { h, target, ask, state } = setup()
    const sent = ask()
    h.services.asks.claim(target, sent.id)
    h.services.sending.reply(target, {
      session_id: target,
      client_msg_id: cmid(),
      ask_id: sent.id,
      text: 'no reply',
      state: 'failed',
    })
    expect(state(sent.id)?.reason).toBe('no_reply')
  })

  it('lets only the asking member cancel, notifying asker and target', () => {
    const { h, bob, asker, target, ask, state, alice } = setup()
    const sent = ask()
    expect(code(() => h.services.asks.cancel(h.as(bob.id), sent.id))).toBe('forbidden')
    h.services.asks.cancel(h.as(alice.id, asker), sent.id)
    expect(state(sent.id)?.state).toBe('cancelled')
    expect(h.link.of(target, 'ask.updated').at(-1)?.params.state).toBe('cancelled')
    expect(code(() => h.services.asks.cancel(h.as(alice.id), sent.id))).toBe('ask_closed')
  })

  it('restricts ask.get to active grant holders', () => {
    const { h, ask } = setup()
    const carol = h.member('carol')
    const sent = ask()
    expect(code(() => h.services.asks.get(h.as(carol.id), sent.id))).toBe('forbidden')
  })

  it('requeues delivered asks and fails working ones when the holder is lost', () => {
    const { h, target, ask, state } = setup()
    const delivered = ask()
    const working = ask()
    h.services.asks.claim(target, working.id)
    h.services.presence.offline(target)
    expect(state(delivered.id)?.state).toBe('queued')
    expect(state(working.id)?.state).toBe('failed')
    expect(state(working.id)?.reason).toBe('target_lost')
  })

  it('re-offers open asks with replay:true when the handle is claimed again', () => {
    const { h, bob, room, target, ask } = setup()
    h.services.sessions.close(target)
    const queued = ask()
    const next = h.open(bob.id, 'b2')
    h.link.clear()
    h.join(next, room, 'work')
    h.services.messages.deliverRoom(next, room, 'work')
    const offers = h.link.of(next, 'msg.new').filter((n) => n.params.replay === true)
    expect(offers.map((n) => (n.params.message as { id: string }).id)).toContain(queued.id)
    expect(h.link.of(next, 'replay.done')).toHaveLength(1)
  })

  it('fails open asks with not_in_room when a handle leaves', () => {
    const { h, room, target, ask, state } = setup()
    const sent = ask()
    h.services.rooms.leave(target, room)
    expect(state(sent.id)?.state).toBe('failed')
    expect(state(sent.id)?.reason).toBe('not_in_room')
  })

  it('enforces target, require_online, outdated and per-asker limits', () => {
    const { h, bob, room, asker, target, ask } = setup()
    expect(
      code(() =>
        h.services.sending.send(asker, {
          session_id: asker,
          client_msg_id: cmid(),
          room_id: room,
          kind: 'ask',
          to: ['nobody'],
          text: 'x',
        }),
      ),
    ).toBe('target_not_found')
    expect(
      code(() =>
        h.services.sending.send(asker, {
          session_id: asker,
          client_msg_id: cmid(),
          room_id: room,
          kind: 'ask',
          to: ['home'],
          text: 'x',
        }),
      ),
    ).toBe('invalid_params')
    ask()
    ask()
    ask()
    expect(code(() => ask())).toBe('rate_limited')
    h.services.sessions.close(target)
    expect(code(() => ask('x', { require_online: true }))).toBe('target_offline')
    const outdated = h.open(bob.id, 'b-old', {}, { outdated: true })
    h.join(outdated, room, 'old')
    expect(
      code(() =>
        h.services.sending.send(asker, {
          session_id: asker,
          client_msg_id: cmid(),
          room_id: room,
          kind: 'ask',
          to: ['old'],
          text: 'x',
        }),
      ),
    ).toBe('adapter_outdated')
  })

  it('caps open asks per target handle at 20', () => {
    const { h, room, ask } = setup()
    for (let i = 0; i < 7; i += 1) {
      const m = h.member(`m${i}`)
      h.grant(room, m.id)
      const s = h.open(m.id, `k${i}`)
      h.join(s, room, `asker${i}`)
      for (let j = 0; j < 3; j += 1) {
        if (i * 3 + j >= 20) break
        h.services.sending.send(s, {
          session_id: s,
          client_msg_id: cmid(),
          room_id: room,
          kind: 'ask',
          to: ['work'],
          text: 'x',
        })
      }
    }
    expect(code(() => ask())).toBe('target_busy')
  })

  it('forbids asks from readonly members', () => {
    const { h, room } = setup()
    const reader = h.member('reader')
    h.grant(room, reader.id, 'readonly')
    const s = h.open(reader.id, 'r1')
    h.join(s, room, 'reader')
    expect(
      code(() =>
        h.services.sending.send(s, {
          session_id: s,
          client_msg_id: cmid(),
          room_id: room,
          kind: 'ask',
          to: ['work'],
          text: 'x',
        }),
      ),
    ).toBe('forbidden')
    expect(
      code(() =>
        h.services.sending.send(s, {
          session_id: s,
          client_msg_id: cmid(),
          room_id: room,
          kind: 'chat',
          text: 'hello',
        }),
      ),
    ).toBe('ok')
  })

  it('expires asks past their TTL in the sweeper', () => {
    const { h, asker, target, ask, state } = setup()
    const sent = ask('q', { ttl_ms: 1000 })
    h.clock.advance(1001)
    expect(h.services.sweeper.sweep().expiredAsks).toBe(1)
    expect(state(sent.id)?.state).toBe('expired')
    expect(h.link.of(asker, 'ask.updated').at(-1)?.params.reason).toBe('expired')
    expect(h.link.of(target, 'ask.updated').at(-1)?.params.state).toBe('expired')
  })
})
