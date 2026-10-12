import { afterEach, describe, expect, it } from 'bun:test'
import { KNOCK_RETRY_AFTER_DECLINE_MS } from '@agent-peers/core'
import { errorOf, type Peer, startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

describe('L2: joining by room_name and by knocking', () => {
  it('a member brings another of their own conversations in with room_name', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const { roomId } = await world.createRoom(alice, 'timely', 'home')
    const second = await world.peer('alice', { localKey: 'second-conv' })
    const joined = await second.session.join({ room_name: 'timely', handle: 'home-2' })
    expect(joined.room.room_id).toBe(roomId)
    expect(joined.members.map((m) => m.handle).sort()).toEqual(['home', 'home-2'])

    const outsider = await world.peer('carol')
    expect(await errorOf(outsider.session.join({ room_name: 'timely' }))).toEqual({ code: 'forbidden' })
    expect(await errorOf(outsider.session.join({ room_name: 'nope' }))).toEqual({ code: 'room_not_found' })
  })

  it('search → knock → accept → knock.updated → join', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const { roomId } = await world.createRoom(alice, 'timely', 'home')
    const carol = await world.peer('carol')

    const found = await carol.session.search('time')
    expect(found.rooms).toEqual([
      expect.objectContaining({
        room_id: roomId,
        name: 'timely',
        owner: 'alice',
        member_count: 1,
        my_state: 'none',
      }),
    ])
    const { knock_id } = await carol.session.knock(roomId, 'can I help with retries?')
    expect(carol.session.view.knocks).toEqual([{ knock_id, room_id: roomId, state: 'pending' }])
    expect(await errorOf(carol.session.knock(roomId))).toEqual({ code: 'knock_pending' })
    expect((await carol.session.search('timely')).rooms[0]?.my_state).toBe('knocking')
    expect(await errorOf(carol.session.join({ room_name: 'timely' }))).toEqual({ code: 'forbidden' })

    const notOwner = carol.client.request('knock.decide', {
      session_id: carol.id,
      knock_id,
      decision: 'accept',
    })
    expect(await errorOf(notOwner)).toEqual({ code: 'forbidden' })

    await alice.client.request('knock.decide', { session_id: alice.id, knock_id, decision: 'accept' })
    const updated = await carol.inbox.waitFor('knock.updated', (n) => n.knock_id === knock_id)
    expect(updated).toMatchObject({ room_id: roomId, state: 'accepted', session_id: carol.id })
    expect(carol.session.view.knocks).toEqual([{ knock_id, room_id: roomId, state: 'accepted' }])

    const joined = await carol.session.join({ room_name: 'timely', handle: 'helper' })
    expect(joined.handle).toBe('helper')
    await alice.inbox.waitFor('msg.new', (n) => n.message.text === '@helper joined')
    expect(await errorOf(carol.session.knock(roomId))).toEqual({ code: 'already_member' })
  })

  it('a decline notifies the knocker and blocks a new knock for 24 h', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const { roomId } = await world.createRoom(alice, 'timely', 'home')
    const dave = await world.peer('dave')

    const first = await dave.session.knock(roomId)
    await alice.client.request('knock.decide', {
      session_id: alice.id,
      knock_id: first.knock_id,
      decision: 'decline',
    })
    const updated = await dave.inbox.waitFor('knock.updated', (n) => n.knock_id === first.knock_id)
    expect(updated.state).toBe('declined')

    const blocked = await errorOf(dave.session.knock(roomId))
    expect(blocked.code).toBe('rate_limited')
    expect(blocked.retryAfterMs).toBe(KNOCK_RETRY_AFTER_DECLINE_MS)

    world.clock.advance(KNOCK_RETRY_AFTER_DECLINE_MS - 1)
    expect((await errorOf(dave.session.knock(roomId))).retryAfterMs).toBe(1)
    world.clock.advance(1)
    const again = await dave.session.knock(roomId, 'second try')
    expect(again.knock_id).not.toBe(first.knock_id)

    await dave.session.withdraw(again.knock_id)
    expect(dave.session.view.knocks.map((k) => k.knock_id)).toEqual([first.knock_id])
  })
})

interface Setup {
  readonly alice: Peer
  readonly bob: Peer
  readonly roomId: string
  readonly askId: string
}

/** alice owns `team` as @home, bob joined as @work, and an ask from bob to alice is open. */
async function withOpenAsk(w: World): Promise<Setup> {
  const alice = await w.peer('alice')
  const bob = await w.peer('bob')
  const { roomId } = await w.pair(alice, bob)
  const sent = await bob.session.ask({ room_id: roomId, to: 'home', text: 'open question' })
  await alice.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)
  return { alice, bob, roomId, askId: sent.id }
}

async function expectNotInRoom(peer: Peer, askId: string): Promise<void> {
  const failed = await peer.inbox.waitFor('ask.updated', (n) => n.ask_id === askId && n.state === 'failed')
  expect(failed.reason).toBe('not_in_room')
}

describe('L2: removal produces room.removed and fails open asks with not_in_room', () => {
  it('room.remove_session by the owner', async () => {
    world = await startWorld()
    const { alice, bob, roomId, askId } = await withOpenAsk(world)
    await alice.session.removeSession(roomId, bob.id)
    const removed = await bob.inbox.waitFor('room.removed', (n) => n.room_id === roomId)
    expect(removed.reason).toBe('removed')
    expect(bob.session.view.rooms).toEqual([])
    await expectNotInRoom(bob, askId)
    expect((await alice.session.getAsk(askId)).ask).toMatchObject({ state: 'failed', reason: 'not_in_room' })
    await alice.inbox.waitFor('msg.new', (n) => n.message.text === '@work was removed')
    // The grant stays: bob can bring the session back.
    const back = await bob.session.join({ room_id: roomId, handle: 'work' })
    expect(back.handle).toBe('work')
  })

  it('room.exit by the member', async () => {
    world = await startWorld()
    const { alice, bob, roomId, askId } = await withOpenAsk(world)
    expect(await errorOf(alice.session.exit(roomId))).toEqual({ code: 'forbidden' })
    await bob.session.exit(roomId)
    const removed = await bob.inbox.waitFor('room.removed', (n) => n.room_id === roomId)
    expect(removed.reason).toBe('removed')
    await expectNotInRoom(bob, askId)
    expect(await errorOf(bob.session.join({ room_id: roomId }))).toEqual({ code: 'forbidden' })
  })

  it('room.kick, then restore re-grants the member', async () => {
    world = await startWorld()
    const { alice, bob, roomId, askId } = await withOpenAsk(world)
    await alice.client.request('room.kick', { session_id: alice.id, room_id: roomId, member: 'bob' })
    const removed = await bob.inbox.waitFor('room.removed', (n) => n.room_id === roomId)
    expect(removed.reason).toBe('kicked')
    const kicked = await bob.inbox.waitFor('kicked', (n) => n.room_id === roomId)
    expect(kicked.reason).toBe('removed by the room owner')
    await expectNotInRoom(bob, askId)
    expect(await errorOf(bob.session.join({ room_id: roomId }))).toEqual({ code: 'forbidden' })

    const owner = { kind: 'member', memberId: alice.memberId } as const
    expect(world.hub.services.membership.kicked(owner, roomId).map((k) => k.member)).toEqual(['bob'])
    world.hub.services.membership.restore(owner, roomId, 'bob')
    const back = await bob.session.join({ room_id: roomId, handle: 'work' })
    expect(back.handle).toBe('work')
    const again = await bob.session.ask({ room_id: roomId, to: 'home', text: 'back again' })
    expect(again.ask?.state).toBe('delivered')
  })

  it('room.dissolve by the owner', async () => {
    world = await startWorld()
    const { alice, bob, roomId, askId } = await withOpenAsk(world)
    expect(
      await errorOf(bob.client.request('room.dissolve', { session_id: bob.id, room_id: roomId })),
    ).toEqual({
      code: 'forbidden',
    })
    await alice.client.request('room.dissolve', { session_id: alice.id, room_id: roomId })
    const [toBob, toAlice] = await Promise.all([
      bob.inbox.waitFor('room.removed', (n) => n.room_id === roomId),
      alice.inbox.waitFor('room.removed', (n) => n.room_id === roomId),
    ])
    expect(toBob.reason).toBe('dissolved')
    expect(toAlice.reason).toBe('dissolved')
    await expectNotInRoom(bob, askId)
    expect(bob.session.view.rooms).toEqual([])
    expect(await errorOf(bob.session.join({ room_id: roomId }))).toEqual({ code: 'room_not_found' })
  })
})
