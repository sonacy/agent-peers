import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ULID_RE } from '@agent-peers/protocol'
import { HubClient } from '../src/client/hub-client'
import { SessionHandle } from '../src/session/session-handle'
import type { SessionView } from '../src/session/view'
import { bridge, FakeHub, fail, fullCard, ok } from './helpers/fake-hub'

const card = {
  agent: { kind: 'claude-code', version: '2.1.0', adapter: '0.2.0' },
  host: 'test-host',
  title: 'T',
}
const room = (room_id: string, name = room_id) => ({ room_id, name })

let hub: FakeHub
let client: HubClient
let opens = 0

beforeEach(async () => {
  hub = new FakeHub()
  opens = 0
  hub.on('session.open', () => {
    opens += 1
    return ok({ session_id: 'S1', rooms: [] })
  })
  hub.on('room.join', (p) =>
    ok({
      room: room(String(p.room_id ?? p.room_name ?? 'r-invite')),
      handle: String(p.handle ?? 'work'),
      members: [],
    }),
  )
  for (const m of [
    'session.update',
    'room.leave',
    'room.exit',
    'room.remove_session',
    'knock.withdraw',
    'session.close',
  ])
    hub.on(m, () => ok({}))
  client = new HubClient({
    bridge,
    requestTimeoutMs: 1000,
    reconnect: { initialMs: 10, maxMs: 20, jitter: 0 },
  })
  await client.connect(hub.url, 'tok')
})

afterEach(async () => {
  await client.close()
  hub.stop()
})

const openHandle = async (options: Partial<ConstructorParameters<typeof SessionHandle>[1]> = {}) => {
  const handle = new SessionHandle(client, { localKey: 'lk-1', card, ...options })
  await handle.open()
  return handle
}

describe('SessionHandle lifecycle', () => {
  it('opens with supersedes once and exposes an immutable view', async () => {
    const handle = new SessionHandle(client, { localKey: 'lk-1', card, supersedes: 'old-key' })
    expect(() => handle.sessionId).toThrow()
    const changes: SessionView[] = []
    handle.onChange((v) => changes.push(v))
    const before = handle.view
    await handle.open()
    expect(hub.callsOf('session.open')[0]?.params).toEqual({ local_key: 'lk-1', card, supersedes: 'old-key' })
    expect(handle.sessionId).toBe('S1')
    expect(handle.view.supersedes).toBeUndefined()
    expect(before.status).toBe('new')
    expect(changes.map((v) => v.status)).toEqual(['opening', 'open'])
  })

  it('returns to new when open fails', async () => {
    hub.on('session.open', () => fail('unauthorized'))
    const handle = new SessionHandle(client, { localKey: 'lk-1', card })
    await expect(handle.open()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(handle.view.status).toBe('new')
  })

  it('records held rooms reported by open', async () => {
    hub.on('session.open', () =>
      ok({
        session_id: 'S1',
        rooms: [
          { room: room('r1', 'one'), handle: 'work' },
          { room_id: 'r2', handle: 'work', status: 'held' },
          { room: 'r3', handle: 'w3' },
          { handle: 'orphan' },
        ],
      }),
    )
    const handle = await openHandle()
    expect(handle.view.rooms).toEqual([
      { room_id: 'r1', handle: 'work', name: 'one' },
      { room_id: 'r3', handle: 'w3' },
    ])
    expect(handle.view.heldRooms).toEqual([{ room_id: 'r2', handle: 'work' }])
  })

  it('closes the session', async () => {
    const handle = await openHandle()
    await handle.close()
    expect(handle.view.status).toBe('closed')
    expect(hub.callsOf('session.close')[0]?.params).toEqual({ session_id: 'S1' })
    expect(() => handle.sessionId).toThrow()
  })
})

describe('SessionHandle rooms and card', () => {
  it('tracks join, leave, exit and removeSession', async () => {
    const handle = await openHandle()
    await handle.join({ room_id: 'r1', handle: 'work' })
    await handle.join({ room_name: 'r2' })
    await handle.join({ invite_code: 'CODE' })
    expect(handle.view.rooms.map((r) => `${r.room_id}@${r.handle}`)).toEqual([
      'r1@work',
      'r2@work',
      'r-invite@work',
    ])
    await handle.leave('r1')
    await handle.exit('r2')
    await handle.removeSession('r-invite', 'OTHER')
    expect(handle.view.rooms.map((r) => r.room_id)).toEqual(['r-invite'])
    await handle.removeSession('r-invite', 'S1')
    expect(handle.view.rooms).toEqual([])
  })

  it('applies update and rename results to the card and handles', async () => {
    hub.on('session.rename', () =>
      ok({ title: '新标题', rooms: [{ room_id: 'r1', old: 'work', new: 'job' }] }),
    )
    const handle = await openHandle()
    await handle.join({ room_id: 'r1', handle: 'work' })
    await handle.update({ summary: 'refactoring', activity: 'busy', model: undefined })
    expect(handle.view.card).toMatchObject({ summary: 'refactoring', activity: 'busy', title: 'T' })
    expect('model' in handle.view.card).toBe(false)
    const result = await handle.rename({ title: '新标题', handle: 'job' })
    expect(result.rooms).toHaveLength(1)
    expect(handle.view.card.title).toBe('新标题')
    expect(handle.view.rooms[0]?.handle).toBe('job')
  })

  it('tracks knocks and passes through list/peers/search/login', async () => {
    hub.on('room.knock', () => ok({ knock_id: 'k1' }))
    hub.on('room.list', () => ok({ rooms: [{ room: room('r1'), handle: 'work', unread: 2 }] }))
    hub.on('peers.list', (p) =>
      ok({ members: [{ room_id: p.room_id ?? 'r1', handle: 'h', card: fullCard('S7') }] }),
    )
    hub.on('room.search', () =>
      ok({ rooms: [{ room_id: 'r9', name: 'nine', owner: 'bob', member_count: 2, my_state: 'none' }] }),
    )
    hub.on('dashboard.login', () => ok({ code: 'c', url: 'https://hub/app/login?c=c' }))
    const handle = await openHandle()
    await handle.knock('r9', 'let me in')
    expect(hub.callsOf('room.knock')[0]?.params).toEqual({
      session_id: 'S1',
      room_id: 'r9',
      note: 'let me in',
    })
    expect(handle.view.knocks).toEqual([{ knock_id: 'k1', room_id: 'r9', state: 'pending' }])
    await handle.withdraw('k1')
    expect(handle.view.knocks).toEqual([])
    expect((await handle.list()).rooms[0]?.unread).toBe(2)
    expect((await handle.peers()).members[0]?.room_id).toBe('r1')
    expect((await handle.peers('r5')).members[0]?.room_id).toBe('r5')
    expect((await handle.search('nine')).rooms[0]?.name).toBe('nine')
    expect((await handle.dashboardLogin()).code).toBe('c')
  })
})

describe('SessionHandle messages', () => {
  it('builds sends with ULID client_msg_ids', async () => {
    hub.on('msg.send', () => ok({ id: 'm', seq: 1, ask: { state: 'queued', expires_at: 5 } }))
    hub.on('msg.reply', () => ok({ id: 'r', seq: 2 }))
    hub.on('msg.progress', () => ok({ id: 'p', seq: 3 }))
    const handle = await openHandle()
    await handle.send({ room_id: 'r1', text: 'hello', to: ['bob'] })
    const asked = await handle.ask({ room_id: 'r1', to: 'work', text: 'q?', ttl_ms: 1000 })
    await handle.ask({
      room_id: 'r1',
      to: 'work',
      text: 'w',
      mode: 'write',
      client_msg_id: 'FIXED',
      require_online: true,
    })
    await handle.reply({ ask_id: 'a1', text: 'answer' })
    await handle.progress({ ask_id: 'a1', text: 'working' })
    expect(asked.ask?.state).toBe('queued')
    const [chat, ask, write] = hub.callsOf('msg.send').map((c) => c.params)
    expect(chat).toMatchObject({ kind: 'chat', to: ['bob'], text: 'hello', session_id: 'S1' })
    expect(String(chat?.client_msg_id)).toMatch(ULID_RE)
    expect(ask).toMatchObject({ kind: 'ask', to: ['work'], meta: { mode: 'read' }, ttl_ms: 1000 })
    expect(write).toMatchObject({ client_msg_id: 'FIXED', meta: { mode: 'write' }, require_online: true })
    expect(hub.callsOf('msg.reply')[0]?.params).toMatchObject({ ask_id: 'a1', state: 'answered' })
    expect(String(hub.callsOf('msg.progress')[0]?.params.client_msg_id)).toMatch(ULID_RE)
  })

  it('rejects text over 64 KiB before sending', async () => {
    const handle = await openHandle()
    await expect(handle.send({ room_id: 'r1', text: 'x'.repeat(70_000) })).rejects.toMatchObject({
      code: 'payload_too_large',
    })
    expect(hub.callsOf('msg.send')).toHaveLength(0)
  })

  it('passes through claim, cancel, getAsk, ack and history', async () => {
    const ask = {
      ask_id: 'a1',
      room_id: 'r1',
      from_handle: 'home',
      from_member: 'gulei',
      to_handle: 'work',
      state: 'working',
      expires_at: 10,
    }
    const message = { id: 'a1', room_id: 'r1', seq: 1, kind: 'ask', text: 'q', ts: 1 }
    hub.on('ask.claim', () => ok({ ask }))
    hub.on('ask.get', () => ok({ ask, messages: [message] }))
    hub.on('ask.cancel', () => ok({}))
    hub.on('msg.ack', () => ok({}))
    hub.on('msg.history', () => ok({ messages: [message] }))
    const handle = await openHandle()
    expect((await handle.claim('a1')).ask.state).toBe('working')
    expect((await handle.getAsk('a1')).messages).toHaveLength(1)
    await handle.cancel('a1')
    await handle.ack('r1', 9)
    expect((await handle.history('r1', { limit: 10 })).messages[0]?.kind).toBe('ask')
    expect(hub.callsOf('msg.ack')[0]?.params).toEqual({ session_id: 'S1', room_id: 'r1', seq: 9 })
    expect(hub.callsOf('msg.history')[0]?.params).toEqual({ session_id: 'S1', room_id: 'r1', limit: 10 })
  })
})

describe('SessionHandle notifications', () => {
  it('applies session-scoped notifications and ignores other sessions', async () => {
    const handle = await openHandle()
    await handle.join({ room_id: 'r1', handle: 'work' })
    await handle.join({ room_id: 'r2', handle: 'work' })
    await handle.join({ room_id: 'r3', handle: 'work' })
    await handle.join({ room_id: 'r4', handle: 'work' })
    await handle.join({ room_id: 'r5', handle: 'work' })
    const seen: string[] = []
    handle.on('msg.new', (n) => seen.push(n.message.id))
    hub.notify('handle.renamed', { session_id: 'S1', room_id: 'r1', old: 'work', new: 'job', by: 'admin' })
    hub.notify('handle.lost', { session_id: 'S1', room_id: 'r2', handle: 'work', by: 'S9', ask_ids: [] })
    hub.notify('room.removed', { session_id: 'S1', room_id: 'r3', reason: 'kicked' })
    hub.notify('kicked', { session_id: 'S1', room_id: 'r4' })
    hub.notify('room.closed', { session_id: 'S1', room_id: 'r5' })
    hub.notify('room.closed', { session_id: 'S1' })
    hub.notify('session.patched', { session_id: 'S1', accepting: false, title: 'from dashboard' })
    hub.notify('knock.updated', { session_id: 'S1', knock_id: 'k1', room_id: 'r9', state: 'accepted' })
    hub.notify('room.removed', { session_id: 'OTHER', room_id: 'r1', reason: 'removed' })
    hub.notify('msg.new', {
      session_id: 'OTHER',
      message: { id: 'x', room_id: 'r1', seq: 1, kind: 'chat', text: '', ts: 1 },
    })
    hub.notify('msg.new', {
      session_id: 'S1',
      message: { id: 'y', room_id: 'r1', seq: 2, kind: 'chat', text: '', ts: 1 },
    })
    await hub.waitFor(() => seen.length === 1)
    expect(seen).toEqual(['y'])
    expect(handle.view.rooms).toEqual([{ room_id: 'r1', handle: 'job', name: 'r1' }])
    expect(handle.view.card).toMatchObject({ accepting: false, title: 'from dashboard' })
    expect(handle.view.knocks).toEqual([{ knock_id: 'k1', room_id: 'r9', state: 'accepted' }])
  })

  it('dispose stops updates', async () => {
    const handle = await openHandle()
    await handle.join({ room_id: 'r1', handle: 'work' })
    handle.dispose()
    hub.notify('kicked', { session_id: 'S1', room_id: 'r1' })
    await Bun.sleep(20)
    expect(handle.view.rooms).toHaveLength(1)
  })
})

describe('SessionHandle resync after reconnect', () => {
  it('re-opens with the latest card and trusts the open result over remembered rooms', async () => {
    const handle = await openHandle({ supersedes: 'boot' })
    await handle.join({ room_id: 'r1', handle: 'work' })
    await handle.join({ room_id: 'r2', handle: 'home' })
    await handle.join({ room_id: 'r3', handle: 'w3' })
    await handle.update({ summary: 'latest' })
    const lost: string[] = []
    handle.onRoomLost((r) => lost.push(`${r.room_id}@${r.handle}`))
    hub.on('session.open', () =>
      ok({
        session_id: 'S1',
        rooms: [
          { room: room('r1'), handle: 'work' },
          { room_id: 'r3', handle: 'w3', status: 'held' },
        ],
      }),
    )
    hub.dropAll()
    await hub.waitFor(() => client.state === 'connected' && lost.length === 1)
    const reopen = hub.callsOf('session.open')[1]?.params
    expect(reopen).toEqual({ local_key: 'lk-1', card: { ...card, summary: 'latest' } })
    // r2 was removed while offline (e.g. room.remove_session): it is reported, never re-joined.
    expect(hub.callsOf('room.join')).toHaveLength(3)
    expect(lost).toEqual(['r2@home'])
    expect(handle.view.rooms.map((r) => r.room_id)).toEqual(['r1'])
    expect(handle.view.heldRooms.map((r) => r.room_id)).toEqual(['r3'])
  })

  it('remaps queued sends when the session id changes and drops rooms the hub no longer lists', async () => {
    const handle = await openHandle()
    await handle.join({ room_id: 'r1', handle: 'work' })
    const lost: string[] = []
    handle.onRoomLost((r) => lost.push(r.room_id))
    let sends = 0
    hub.on('msg.send', () => {
      sends += 1
      return sends === 1 ? { drop: true } : ok({ id: 'm', seq: 1 })
    })
    hub.on('session.open', () => ok({ session_id: 'S2', rooms: [] }))
    await handle.send({ room_id: 'r1', text: 'hi', client_msg_id: 'C1' })
    const [first, second] = hub.callsOf('msg.send').map((c) => c.params)
    expect(first).toMatchObject({ session_id: 'S1', client_msg_id: 'C1' })
    expect(second).toMatchObject({ session_id: 'S2', client_msg_id: 'C1' })
    expect(handle.sessionId).toBe('S2')
    expect(lost).toEqual(['r1'])
    expect(hub.callsOf('room.join')).toHaveLength(1)
    expect(handle.view.rooms).toEqual([])
  })

  it('defers close while disconnected and closes on resync', async () => {
    const handle = await openHandle()
    const client2 = client
    hub.on('hello', async () => {
      await Bun.sleep(30)
      return ok({ protocol: 'agent-peers/0.3', heartbeat_ms: 10_000, grace_ms: 1, server_time: 1 })
    })
    hub.dropAll()
    await hub.waitFor(() => client2.state !== 'connected')
    await handle.close()
    expect(handle.view.status).toBe('closing')
    await hub.waitFor(() => handle.view.status === 'closed' && client2.state === 'connected')
    expect(hub.callsOf('session.close')).toHaveLength(1)
    // Regression: session.close must name a session on the new connection (§6.4), so the
    // session is reattached first (the real hub answers unknown_session otherwise).
    expect(opens).toBe(2)
    const order = hub.calls.map((c) => c.method).filter((m) => m === 'session.open' || m === 'session.close')
    expect(order).toEqual(['session.open', 'session.open', 'session.close'])
    expect(hub.callsOf('session.open')[1]?.params).toEqual({ local_key: 'lk-1', card })
  })
})
