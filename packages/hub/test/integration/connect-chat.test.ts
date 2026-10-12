import { afterEach, describe, expect, it } from 'bun:test'
import { startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

describe('L2: connect, open, create a room and join by invite', () => {
  it('lists both members online with their cards', async () => {
    world = await startWorld()
    const alice = await world.peer('alice', { title: '调研 T3Code 项目' })
    expect(alice.client.state).toBe('connected')
    expect(alice.client.welcome?.grace_ms).toBe(2_000)
    expect(alice.session.view.status).toBe('open')

    const room = await world.createRoom(alice, 'team', 'home')
    expect(room.inviteUrl).toStartWith(`${world.url}/j/`)
    expect(room.code).toHaveLength(16)

    const bob = await world.peer('bob', { title: 'payments retry' })
    const joined = await bob.session.join({ invite_code: room.code, handle: 'work' })
    expect(joined.handle).toBe('work')
    expect(joined.room.name).toBe('team')
    expect(bob.session.view.rooms).toEqual([{ room_id: room.roomId, handle: 'work', name: 'team' }])
    await bob.inbox.waitFor('replay.done', (n) => n.room_id === room.roomId)

    const seen = await alice.inbox.waitFor('presence.changed', (n) => n.handle === 'work')
    expect(seen.card.member).toBe('bob')

    const listed = await bob.session.peers(room.roomId)
    const byHandle = new Map(listed.members.map((m) => [m.handle, m.card]))
    expect([...byHandle.keys()].sort()).toEqual(['home', 'work'])
    expect(byHandle.get('home')).toMatchObject({
      session_id: alice.id,
      member: 'alice',
      title: '调研 T3Code 项目',
      host: 'alice-laptop',
      connection: 'online',
      agent: { kind: 'claude-code' },
      workspace: { name: 'payments-api' },
    })
    expect(byHandle.get('work')).toMatchObject({
      session_id: bob.id,
      member: 'bob',
      title: 'payments retry',
      connection: 'online',
    })
    const all = await alice.session.peers()
    expect(all.members).toHaveLength(2)
  })

  it('a second invite redemption by the same member keeps one grant and reports both rooms in room.list', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const team = await world.pair(alice, bob)
    const other = await world.createRoom(alice, 'other', 'home')
    await bob.session.join({ invite_code: other.code })
    const rooms = await bob.session.list()
    expect(rooms.rooms.map((r) => r.room_id).sort()).toEqual([team.roomId, other.roomId].sort())
    const defaultHandle = rooms.rooms.find((r) => r.room_id === other.roomId)?.handle
    expect(defaultHandle).toBe('bob-laptop')
  })
})

describe('L2: chat', () => {
  it('sends, delivers msg.new, acks and reads history', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)

    const sent = await alice.session.send({ room_id: roomId, text: 'hello @work' })
    expect(sent.ask).toBeNull()
    const got = await bob.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)
    expect(got.session_id).toBe(bob.id)
    expect(got.replay).toBeUndefined()
    expect(got.message).toMatchObject({
      kind: 'chat',
      seq: sent.seq,
      text: 'hello @work',
      from: { handle: 'home', member: 'alice', session_id: alice.id },
    })
    expect(alice.inbox.all('msg.new', (n) => n.message.id === sent.id)).toHaveLength(0)

    const before = await bob.session.list()
    expect(before.rooms[0]?.unread).toBe(1)
    await bob.session.ack(roomId, got.message.seq)
    const after = await bob.session.list()
    expect(after.rooms[0]?.unread).toBe(0)

    const history = await bob.session.history(roomId)
    const chats = history.messages.filter((m) => m.kind === 'chat')
    expect(chats.map((m) => m.text)).toEqual(['hello @work'])
    expect(history.messages.some((m) => m.kind === 'system' && m.text === '@work joined')).toBe(true)
    const older = await bob.session.history(roomId, { before_seq: sent.seq, limit: 1 })
    expect(older.messages).toHaveLength(1)
    expect(older.messages[0]?.seq).toBeLessThan(sent.seq)
  })

  it('replays chat missed while the session was closed, after the acked cursor', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob', { localKey: 'bob-main' })
    const { roomId } = await world.pair(alice, bob)
    const bobId = bob.id
    await bob.session.close()
    expect(bob.session.view.status).toBe('closed')
    const missed = await alice.session.send({ room_id: roomId, text: 'while you were away' })

    const again = await world.peer('bob', { localKey: 'bob-main' })
    expect(again.id).toBe(bobId)
    const replayed = await again.inbox.waitFor('msg.new', (n) => n.message.id === missed.id)
    expect(replayed.replay).toBe(true)
    const done = await again.inbox.waitFor('replay.done', (n) => n.room_id === roomId)
    expect(done.head_seq).toBeGreaterThanOrEqual(missed.seq)
  })
})
