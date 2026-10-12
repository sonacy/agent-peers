import { afterEach, describe, expect, it } from 'bun:test'
import { SessionHandle } from '@agent-peers/core'
import { cardFor, reconnected, startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

describe('L2: auto-reconnect retries an unanswered msg.send', () => {
  it('re-sends with the same client_msg_id and the hub stores exactly one message', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)

    alice.tap.loseNextResponseTo('msg.send')
    const back = reconnected(alice.client)
    const sent = await alice.session.send({ room_id: roomId, text: 'exactly once' })
    await back

    const attempts = alice.tap.sentOf('msg.send')
    expect(attempts).toHaveLength(2)
    expect(attempts[1]?.params?.client_msg_id).toBe(attempts[0]?.params?.client_msg_id)
    expect(alice.tap.sentOf('session.open')).toHaveLength(2)

    const history = await alice.session.history(roomId)
    const copies = history.messages.filter((m) => m.text === 'exactly once')
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ id: sent.id, seq: sent.seq })

    // A later marker proves bob's stream holds the message once, not twice.
    const marker = await alice.session.send({ room_id: roomId, text: 'marker' })
    await bob.inbox.waitFor('msg.new', (n) => n.message.id === marker.id)
    expect(bob.inbox.all('msg.new', (n) => n.message.text === 'exactly once')).toHaveLength(1)
  })
})

describe('L2: resume after session.close', () => {
  it('a new client with the same identity tuple gets the same session, its handle and its queued asks', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob', { localKey: 'claude-uuid-1' })
    const { roomId } = await world.pair(alice, bob)
    const bobId = bob.id

    await bob.session.close()
    expect(world.sessionRow(bobId)?.closed_at).not.toBeNull()
    await alice.inbox.waitFor(
      'presence.changed',
      (n) => n.handle === 'work' && n.card.connection === 'offline',
    )

    const queued = await alice.session.ask({ room_id: roomId, to: 'work', text: 'when you are back' })
    expect(queued.ask?.state).toBe('queued')

    const resumed = await world.peer('bob', { localKey: 'claude-uuid-1' })
    expect(resumed.id).toBe(bobId)
    expect(resumed.session.view.rooms).toEqual([{ room_id: roomId, handle: 'work', name: 'team' }])
    expect(world.sessionRow(bobId)?.closed_at).toBeNull()

    const offered = await resumed.inbox.waitFor('msg.new', (n) => n.message.id === queued.id)
    expect(offered.replay).toBe(true)
    expect(offered.message.ask?.state).toBe('delivered')
    await alice.inbox.waitFor('ask.updated', (n) => n.ask_id === queued.id && n.state === 'delivered')
    await alice.inbox.waitFor(
      'presence.changed',
      (n) => n.handle === 'work' && n.card.connection === 'online',
    )

    const claimed = await resumed.session.claim(queued.id)
    expect(claimed.ask.assignee_session).toBe(bobId)
  })

  it('a different host is a different identity and gets a new session', async () => {
    world = await startWorld()
    const first = await world.peer('bob', { localKey: 'same-key', host: 'mbp' })
    const firstId = first.id
    const other = await world.peer('bob', { localKey: 'same-key', host: 'desktop' })
    expect(other.id).not.toBe(firstId)
  })
})

describe('L2: supersedes', () => {
  it('moves the handle and queued asks to the new session and closes the old one', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob', { localKey: 'before-clear' })
    const { roomId } = await world.pair(alice, bob)
    const oldId = bob.id

    const pending = await alice.session.ask({ room_id: roomId, to: 'work', text: 'survives /clear' })
    await bob.inbox.waitFor('msg.new', (n) => n.message.id === pending.id)

    const next = await world.peer('bob', { localKey: 'after-clear', supersedes: 'before-clear' })
    expect(next.id).not.toBe(oldId)
    expect(next.session.view.supersedes).toBeUndefined()
    expect(next.session.view.rooms).toEqual([{ room_id: roomId, handle: 'work', name: 'team' }])

    const offered = await next.inbox.waitFor('msg.new', (n) => n.message.id === pending.id)
    expect(offered.replay).toBe(true)
    expect(world.sessionRow(oldId)?.closed_at).not.toBeNull()
    expect(world.sessionRow(oldId)?.connection).toBe('offline')

    const stale = await bob.session.claim(pending.id).catch((e: { code: string }) => e.code)
    expect(stale).toBe('unknown_session')
    const claimed = await next.session.claim(pending.id)
    expect(claimed.ask).toMatchObject({ state: 'working', assignee_session: next.id, to_handle: 'work' })

    const listed = await alice.session.peers(roomId)
    expect(listed.members.find((m) => m.handle === 'work')?.card.session_id).toBe(next.id)
  })
})

describe('L2: session lifecycle across reconnects', () => {
  it('a close requested while reconnecting is sent during resync', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    await world.pair(alice, bob)
    const aliceId = alice.id

    const closedWhileDown = new Promise<void>((resolve, reject) => {
      const off = alice.client.onLifecycle((event) => {
        if (event.type !== 'reconnecting') return
        off()
        alice.session.close().then(resolve, reject)
      })
    })
    const back = reconnected(alice.client)
    alice.tap.crash()
    await closedWhileDown
    expect(alice.session.view.status).toBe('closing')
    await back
    expect(alice.session.view.status).toBe('closed')
    expect(world.sessionRow(aliceId)?.closed_at).not.toBeNull()
    await bob.inbox.waitFor(
      'presence.changed',
      (n) => n.card.session_id === aliceId && n.card.connection === 'offline',
    )
  })

  it('session.open is idempotent on the same connection', async () => {
    world = await startWorld()
    const alice = await world.peer('alice', { localKey: 'k1' })
    const again = await alice.client.request('session.open', { local_key: 'k1', card: cardFor('alice') })
    expect(again.session_id).toBe(alice.id)
    expect(world.hub.registry.sessionCount).toBe(1)
  })

  it('supersedes on the same connection keeps the socket and moves the handle', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob', { localKey: 'conv-a' })
    const { roomId } = await world.pair(alice, bob)
    const oldId = bob.id

    const next = new SessionHandle(bob.client, {
      localKey: 'conv-b',
      card: cardFor('bob'),
      supersedes: 'conv-a',
    })
    await next.open()
    bob.session.dispose()
    expect(next.view.rooms.map((r) => r.handle)).toEqual(['work'])
    expect(bob.client.state).toBe('connected')
    expect(world.hub.registry.connectionOf(oldId)).toBeUndefined()
    expect(world.sessionRow(oldId)?.closed_at).not.toBeNull()

    const sent = await alice.session.send({ room_id: roomId, text: 'after /clear' })
    const got = await bob.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)
    expect(got.session_id).toBe(next.sessionId)
    next.dispose()
  })
})

describe('L2: handle claims across sessions of one member', () => {
  it('a revived session whose handle is now held by a live session reports the room as held', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob', { localKey: 'first' })
    const { roomId } = await world.pair(alice, bob)
    await bob.session.close()

    const second = await world.peer('bob', { localKey: 'second' })
    const joined = await second.session.join({ room_id: roomId, handle: 'work' })
    expect(joined.handle).toBe('work')

    const revived = await world.peer('bob', { localKey: 'first' })
    expect(revived.session.view.rooms).toEqual([])
    expect(revived.session.view.heldRooms).toEqual([{ room_id: roomId, handle: 'work' }])
  })

  it('takeover moves an online handle and the loser gets handle.lost with its open asks', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'who has it?' })
    await bob.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)

    const other = await world.peer('bob', { localKey: 'other' })
    const refused = await other.session
      .join({ room_id: roomId, handle: 'work' })
      .catch((e: { code: string }) => e.code)
    expect(refused).toBe('handle_taken')
    await other.session.join({ room_id: roomId, handle: 'work', takeover: true })

    const lost = await bob.inbox.waitFor('handle.lost', (n) => n.room_id === roomId)
    expect(lost).toMatchObject({ handle: 'work', ask_ids: [sent.id], by: { session_id: other.id } })
    expect(bob.session.view.rooms).toEqual([])
    const offered = await other.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)
    expect(offered.replay).toBe(true)
    const claimed = await other.session.claim(sent.id)
    expect(claimed.ask.assignee_session).toBe(other.id)
  })
})
