import { afterEach, describe, expect, it } from 'bun:test'
import { parseNotification, parseResult } from '@agent-peers/protocol'
import { type RunningHub, startHub } from '../helpers/hub'
import { type TestClient, tick } from '../helpers/ws-client'

let running: RunningHub | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

interface Pair {
  readonly alice: TestClient
  readonly bob: TestClient
  readonly a: string
  readonly b: string
  readonly roomId: string
  readonly bobToken: string
}

async function pair(hub: RunningHub): Promise<Pair> {
  const alice = await hub.client(hub.member('alice'))
  const a = (await alice.open('a1')).session_id
  const created = parseResult(
    'room.create',
    await alice.request('room.create', { session_id: a, name: 'team', handle: 'home' }),
  )
  const bobToken = hub.member('bob')
  const bob = await hub.client(bobToken)
  const b = (await bob.open('b1')).session_id
  const code = created.invite_url.split('/').at(-1)
  const joined = parseResult(
    'room.join',
    await bob.request('room.join', { session_id: b, invite_code: code, handle: 'work' }),
  )
  expect(joined.members.map((m) => m.handle).sort()).toEqual(['home', 'work'])
  await bob.waitFor('replay.done')
  return { alice, bob, a, b, roomId: created.room.room_id, bobToken }
}

describe('ws session lifecycle', () => {
  it('runs an ask end to end: deliver, claim, progress, reply', async () => {
    running = await startHub()
    const { alice, bob, a, b, roomId } = await pair(running)
    const sent = parseResult(
      'msg.send',
      await alice.request('msg.send', {
        session_id: a,
        client_msg_id: 'c1',
        room_id: roomId,
        kind: 'ask',
        to: ['work'],
        text: 'retry policy?',
        meta: { mode: 'read' },
      }),
    )
    expect(sent.ask?.state).toBe('delivered')
    const offered = await bob.waitFor('msg.new', (p) => (p.message as { id: string }).id === sent.id)
    expect(offered.session_id).toBe(b)
    const claimed = parseResult(
      'ask.claim',
      await bob.request('ask.claim', { session_id: b, ask_id: sent.id }),
    )
    expect(claimed.ask.state).toBe('working')
    await bob.request('msg.progress', {
      session_id: b,
      client_msg_id: 'p1',
      ask_id: sent.id,
      text: 'looking',
    })
    await bob.request('msg.reply', {
      session_id: b,
      client_msg_id: 'r1',
      ask_id: sent.id,
      text: 'exponential',
      state: 'answered',
    })
    const updated = await alice.waitFor('ask.updated', (p) => p.state === 'answered')
    expect(updated.ask_id).toBe(sent.id)
    const reply = await alice.waitFor('msg.new', (p) => (p.message as { kind: string }).kind === 'reply')
    expect((reply.message as { text: string }).text).toBe('exponential')
    const got = parseResult('ask.get', await alice.request('ask.get', { session_id: a, ask_id: sent.id }))
    expect(got.messages.map((m) => m.kind)).toEqual(['ask', 'progress', 'reply'])
    const dup = await alice.request('msg.send', {
      session_id: a,
      client_msg_id: 'c1',
      room_id: roomId,
      kind: 'ask',
      to: ['work'],
      text: 'again',
    })
    expect(dup.id).toBe(sent.id)
  })

  it('processes each connection’s requests in order', async () => {
    running = await startHub({ messagesPerMinute: 100 })
    const { alice, a, roomId } = await pair(running)
    const sends = Array.from({ length: 20 }, (_, i) =>
      alice.request<{ seq: number }>('msg.send', {
        session_id: a,
        client_msg_id: `o${i}`,
        room_id: roomId,
        kind: 'chat',
        text: `m${i}`,
      }),
    )
    const seqs = (await Promise.all(sends)).map((r) => r.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })

  it('fences: reattaching on a new connection closes the old socket', async () => {
    running = await startHub()
    const { alice, a, roomId, bob, b } = await pair(running)
    const token = running.member('carol')
    void token
    const again = await running.client(
      running.hub.services.members.issueToken(
        running.hub.services.deps.repos.sessions.byId(a)?.member_id ?? '',
      ),
    )
    const reopened = await again.open('a1')
    expect(reopened.session_id).toBe(a)
    expect(reopened.rooms).toEqual([
      expect.objectContaining({ room_id: roomId, handle: 'home', status: 'joined' }),
    ])
    expect((await alice.closed).code).toBe(4001)
    await again.waitFor('replay.done')
    await bob.request('msg.send', {
      session_id: b,
      client_msg_id: 'x1',
      room_id: roomId,
      kind: 'chat',
      text: 'to the new socket',
    })
    const got = await again.waitFor(
      'msg.new',
      (p) => (p.message as { text: string }).text === 'to the new socket',
    )
    expect(got.session_id).toBe(a)
  })

  it('bye takes sessions offline and closes the socket', async () => {
    running = await startHub()
    const { alice, a, bob } = await pair(running)
    alice.notify('bye')
    expect((await alice.closed).code).toBe(1000)
    await tick()
    expect(running.hub.services.deps.repos.sessions.byId(a)?.connection).toBe('offline')
    const change = await bob.waitFor(
      'presence.changed',
      (p) => (p.card as { connection: string }).connection === 'offline',
    )
    expect(change.handle).toBe('home')
  })

  it('an unclean close goes stale, then offline after grace_ms', async () => {
    running = await startHub({ graceMs: 5000 })
    const { alice, a, bob } = await pair(running)
    alice.ws.close(4999, 'network drop')
    await alice.closed
    await tick()
    expect(running.hub.services.deps.repos.sessions.byId(a)?.connection).toBe('stale')
    running.clock.advance(5000)
    expect(running.hub.services.deps.repos.sessions.byId(a)?.connection).toBe('offline')
    await bob.waitFor('presence.changed', (p) => (p.card as { connection: string }).connection === 'offline')
  })

  it('goes stale after two silent heartbeats and revives on the next frame', async () => {
    running = await startHub({ heartbeatMs: 1000, graceMs: 10_000 })
    const { alice, a } = await pair(running)
    running.clock.advance(2000)
    expect(running.hub.services.deps.repos.sessions.byId(a)?.connection).toBe('stale')
    await alice.request('ping')
    expect(running.hub.services.deps.repos.sessions.byId(a)?.connection).toBe('online')
  })

  it('redelivers when a stale connection comes back after going offline', async () => {
    running = await startHub({ heartbeatMs: 1000, graceMs: 1000 })
    const { alice, a, bob, b, roomId } = await pair(running)
    running.clock.advance(2000)
    running.clock.advance(1000)
    expect(running.hub.services.deps.repos.sessions.byId(a)?.connection).toBe('offline')
    await bob.request('msg.send', {
      session_id: b,
      client_msg_id: 'q1',
      room_id: roomId,
      kind: 'ask',
      to: ['home'],
      text: 'there?',
    })
    await alice.request('ping')
    const offered = await alice.waitFor(
      'msg.new',
      (p) => p.replay === true && (p.message as { kind: string }).kind === 'ask',
    )
    expect((offered.message as { text: string }).text).toBe('there?')
  })

  it('replays chat missed while closed on reopen', async () => {
    running = await startHub()
    const { bob, b, alice, a, roomId, bobToken } = await pair(running)
    await bob.request('session.close', { session_id: b })
    await alice.request('msg.send', {
      session_id: a,
      client_msg_id: 'm1',
      room_id: roomId,
      kind: 'chat',
      text: 'while you were out',
    })
    const fresh = await running.client(bobToken)
    const reopened = await fresh.open('b1')
    expect(reopened.session_id).toBe(b)
    const replayed = await fresh.waitFor('msg.new', (p) => p.replay === true)
    expect((replayed.message as { text: string }).text).toBe('while you were out')
    const done = await fresh.waitFor('replay.done')
    expect(done.room_id).toBe(roomId)
    const doneIndex = fresh.frames.findIndex((f) => f.method === 'replay.done')
    const resultIndex = fresh.frames.findIndex(
      (f) => (f.result as { session_id?: string } | undefined)?.session_id === b,
    )
    expect(resultIndex).toBeLessThan(doneIndex)
  })

  it('serves the room, invite, knock and session methods', async () => {
    running = await startHub()
    const { alice, a, bob, b, roomId } = await pair(running)
    const r = (m: string, p: Record<string, unknown>) => alice.request(m, { session_id: a, ...p })
    expect(parseResult('room.list', await r('room.list', {})).rooms[0]?.handle).toBe('home')
    expect(parseResult('peers.list', await r('peers.list', { room_id: roomId })).members).toHaveLength(2)
    expect(
      parseResult('invite.create', await r('invite.create', { room_id: roomId, lang: 'zh' })).join_prompt,
    ).toContain('房间')
    expect(parseResult('invite.rotate', await r('invite.rotate', { room_id: roomId })).invite_url).toContain(
      '/j/',
    )
    expect(parseResult('invite.close', await r('invite.close', { room_id: roomId }))).toEqual({})
    expect(parseResult('invite.reopen', await r('invite.reopen', { room_id: roomId })).join_prompt).toContain(
      'team',
    )
    await r('session.update', { activity: 'busy', summary: 'hi' })
    expect(
      parseResult('session.rename', await r('session.rename', { title: 'T', handle: 'house' })).rooms[0]?.new,
    ).toBe('house')
    const login = parseResult('dashboard.login', await r('dashboard.login', {}))
    expect(login.url).toContain('/app/login?c=')
    const carolToken = running.member('carol')
    const carol = await running.client(carolToken)
    const c = (await carol.open('c1')).session_id
    expect(
      parseResult('room.search', await carol.request('room.search', { session_id: c, q: 'te' })).rooms[0]
        ?.my_state,
    ).toBe('none')
    const knock = parseResult(
      'room.knock',
      await carol.request('room.knock', { session_id: c, room_id: roomId, note: 'hi' }),
    )
    await carol.request('knock.withdraw', { session_id: c, knock_id: knock.knock_id })
    const knock2 = parseResult(
      'room.knock',
      await carol.request('room.knock', { session_id: c, room_id: roomId }),
    )
    await r('knock.decide', { knock_id: knock2.knock_id, decision: 'accept' })
    expect((await carol.waitFor('knock.updated', (p) => p.state === 'accepted')).room_id).toBe(roomId)
    await carol.request('room.join', { session_id: c, room_name: 'team', handle: 'carol' })
    await r('room.remove_session', { room_id: roomId, target_session_id: c })
    expect((await carol.waitFor('room.removed')).reason).toBe('removed')
    await carol.request('room.exit', { session_id: c, room_id: roomId })
    const sent = await r('msg.send', { client_msg_id: 'z', room_id: roomId, kind: 'chat', text: 'x' })
    await bob.request('msg.ack', { session_id: b, room_id: roomId, seq: sent.seq })
    expect(
      parseResult(
        'msg.history',
        await bob.request('msg.history', { session_id: b, room_id: roomId, limit: 5 }),
      ).messages.length,
    ).toBe(5)
    const q = await r('msg.send', {
      client_msg_id: 'q',
      room_id: roomId,
      kind: 'ask',
      to: ['work'],
      text: '?',
    })
    await r('ask.cancel', { ask_id: q.id })
    await bob.request('room.leave', { session_id: b, room_id: roomId })
    await r('room.kick', { room_id: roomId, member: 'bob' })
    expect((await bob.waitFor('kicked')).room_id).toBe(roomId)
    await r('room.dissolve', { room_id: roomId })
    expect(running.hub.registry.connectionCount).toBe(3)
    expect(running.hub.registry.sessionCount).toBe(3)
    await r('session.close', {})
    expect(running.hub.registry.connectionOf(a)).toBeUndefined()
    for (const client of [alice, bob, carol]) {
      for (const frame of client.frames.filter((f) => f.method !== undefined)) {
        const parsed = parseNotification(frame.method ?? '', frame.params)
        expect(parsed.ok ? 'ok' : `${frame.method}: ${parsed.message}`).toBe('ok')
      }
    }
  })
})
