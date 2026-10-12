import { afterEach, describe, expect, it } from 'bun:test'
import { eventually } from './support/inbox'
import { GRACE_MS, reconnected, startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

describe('L2: graceful bye', () => {
  it('shows the session offline immediately', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const aliceId = alice.id

    await alice.client.close()
    expect(alice.client.state).toBe('closed')
    const change = await bob.inbox.waitFor(
      'presence.changed',
      (n) => n.card.session_id === aliceId && n.card.connection === 'offline',
    )
    expect(change.handle).toBe('home')
    expect(world.sessionRow(aliceId)?.connection).toBe('offline')

    const listed = await bob.session.peers(roomId)
    expect(listed.members.find((m) => m.handle === 'home')?.card.connection).toBe('offline')
  })
})

describe('L2: crash, grace and reconnect', () => {
  it('a crash goes stale at once and offline after grace_ms', async () => {
    world = await startWorld()
    const alice = await world.peer('alice', { reconnect: false })
    const bob = await world.peer('bob')
    await world.pair(alice, bob)
    const aliceId = alice.id

    alice.tap.crash()
    await eventually(() => world?.sessionRow(aliceId)?.connection === 'stale', 'stale')
    expect(alice.client.state).toBe('idle')
    expect(
      bob.inbox.all(
        'presence.changed',
        (n) => n.card.session_id === aliceId && n.card.connection !== 'online',
      ),
    ).toEqual([])

    world.clock.advance(GRACE_MS - 1)
    expect(world.sessionRow(aliceId)?.connection).toBe('stale')
    world.clock.advance(1)
    expect(world.sessionRow(aliceId)?.connection).toBe('offline')
    const change = await bob.inbox.waitFor(
      'presence.changed',
      (n) => n.card.session_id === aliceId && n.card.connection === 'offline',
    )
    expect(change.handle).toBe('home')
  })

  it('a reconnect within grace is invisible: observers never see offline', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const aliceId = alice.id

    const back = reconnected(alice.client)
    alice.tap.crash()
    await back
    expect(alice.tap.connections).toBe(2)
    expect(alice.session.view.sessionId).toBe(aliceId)
    expect(alice.session.view.rooms.map((r) => r.handle)).toEqual(['home'])
    expect(world.sessionRow(aliceId)?.connection).toBe('online')

    world.clock.advance(GRACE_MS * 2)
    expect(world.sessionRow(aliceId)?.connection).toBe('online')

    // A round trip through the hub orders every notification it sent before this point.
    const listed = await bob.session.peers(roomId)
    expect(listed.members.find((m) => m.handle === 'home')?.card.connection).toBe('online')
    expect(
      bob.inbox.all(
        'presence.changed',
        (n) => n.card.session_id === aliceId && n.card.connection !== 'online',
      ),
    ).toEqual([])

    const sent = await bob.session.send({ room_id: roomId, text: 'still here?' })
    const got = await alice.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)
    expect(got.session_id).toBe(aliceId)
  })

  it('missed heartbeats make the session stale; the next frame revives it', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const aliceId = alice.id
    world.clock.advance(world.hub.config.heartbeatMs * 2)
    expect(world.sessionRow(aliceId)?.connection).toBe('stale')
    await alice.session.list()
    expect(world.sessionRow(aliceId)?.connection).toBe('online')
  })
})

describe('L2: activity fan-out', () => {
  it('coalesces session.update into at most one presence.changed per second', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const aliceId = alice.id

    await alice.session.update({ activity: 'busy', summary: 'refactoring retry policy' })
    await alice.session.update({ activity: 'awaiting_input' })
    expect(alice.session.view.card.activity).toBe('awaiting_input')
    await bob.session.peers(roomId)
    const fromAlice = (activity: string) =>
      bob.inbox.all('presence.changed', (n) => n.card.session_id === aliceId && n.card.activity === activity)
    expect(fromAlice('busy')).toEqual([])
    expect(fromAlice('awaiting_input')).toEqual([])

    world.clock.advance(1000)
    const change = await bob.inbox.waitFor(
      'presence.changed',
      (n) => n.card.session_id === aliceId && n.card.activity === 'awaiting_input',
    )
    expect(change.card.summary).toBe('refactoring retry policy')
    expect(fromAlice('busy')).toEqual([])
  })
})
