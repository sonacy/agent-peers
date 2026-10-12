import { afterEach, describe, expect, it } from 'bun:test'
import { HubClient, type LifecycleEvent, type SessionRoom } from '@agent-peers/core'
import { ADMIN } from '../../src/services/access'
import { TestClient } from '../helpers/ws-client'
import { errorOf, reconnected, startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

const waitUntil = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await Bun.sleep(5)
  }
}

describe('L2: changes made while a bridge is offline stick', () => {
  it('a session removed while its bridge was down is not re-joined on reconnect', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const lost: SessionRoom[] = []
    bob.session.onRoomLost((room) => lost.push(room))
    const bobId = bob.id

    const back = reconnected(bob.client)
    bob.tap.crash()
    world.hub.services.membership.removeSession(ADMIN, roomId, bobId)
    await back
    await waitUntil(() => bob.session.view.rooms.length === 0)

    expect(bob.tap.sentOf('room.join')).toHaveLength(1)
    expect(world.hub.services.deps.repos.handles.bySession(bobId, roomId)).toBeUndefined()
    // Either the live room.removed or the resync reported it; never a silent re-join.
    expect(lost.length + bob.inbox.all('room.removed').length).toBeGreaterThan(0)
  })
})

describe('L2: revoking a member token', () => {
  it('closes the live socket with 4401, takes the session offline and stops reconnects', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const bobId = bob.id
    const events: LifecycleEvent[] = []
    bob.client.onLifecycle((e) => events.push(e))

    world.hub.services.members.revokeTokens(bob.memberId)
    await waitUntil(() => bob.client.state === 'closed')
    expect(events.at(-1)).toMatchObject({ type: 'closed', error: { code: 'unauthorized' } })
    expect(world.sessionRow(bobId)?.connection).toBe('offline')
    expect(await errorOf(bob.session.list())).toEqual({ code: 'closed' })
    await alice.inbox.waitFor(
      'presence.changed',
      (n) => n.handle === 'work' && n.card.connection === 'offline',
    )
    expect(world.hub.registry.connectionCount).toBe(1)

    const again = new HubClient({
      bridge: { agent_kind: 'claude-code', agent_version: '2.1.0', adapter: '0.3.0', host: 'bob-laptop' },
      requestTimeoutMs: 1000,
    })
    expect(await errorOf(again.connect(world.url, bob.token))).toEqual({ code: 'unauthorized' })
    await again.close()
    expect(roomId).toBeTruthy()
  })
})

describe('L2: a joiner sees nothing live before its join result and replay.done (§6.3)', () => {
  it('does not send the joiner its own "joined" notice', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const room = await world.createRoom(alice, 'team', 'home')
    const token = world.hub.services.members.create('bob').token
    const bob = await TestClient.connect(`${world.url.replace('http', 'ws')}/v0/ws`, token)
    await bob.hello()
    const { session_id } = await bob.open('bob-1')
    const joined = await bob.request<{ handle: string }>('room.join', {
      session_id,
      invite_code: room.code,
      handle: 'work',
    })
    expect(joined.handle).toBe('work')
    await bob.waitFor('replay.done', (n) => n.room_id === room.roomId)
    const frames = bob.frames.filter((f) => f.method !== undefined || f.result !== undefined)
    const resultAt = frames.findIndex((f) => (f.result as { handle?: string } | undefined)?.handle === 'work')
    const doneAt = frames.findIndex((f) => f.method === 'replay.done')
    expect(resultAt).toBeGreaterThanOrEqual(0)
    expect(doneAt).toBeGreaterThan(resultAt)
    expect(bob.notifications('msg.new')).toEqual([])
    const seen = await alice.inbox.waitFor('msg.new', (n) => n.message.text === '@work joined')
    expect(seen.message.kind).toBe('system')
    bob.close()
  })
})
