import { afterEach, describe, expect, it } from 'bun:test'
import { errorOf, startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

describe('L2: authorization', () => {
  it('a readonly grant may chat but not ask', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const carol = await world.peer('carol')
    world.hub.services.deps.repos.grants.upsert(roomId, carol.memberId, 'readonly', world.clock.now())

    await carol.session.join({ room_id: roomId, handle: 'watcher' })
    const chat = await carol.session.send({ room_id: roomId, text: 'just watching' })
    await alice.inbox.waitFor('msg.new', (n) => n.message.id === chat.id)
    expect(await errorOf(carol.session.ask({ room_id: roomId, to: 'home', text: 'may I?' }))).toEqual({
      code: 'forbidden',
    })
  })

  it('only the assignee may reply or report progress', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'who answers?' })

    expect(await errorOf(bob.session.reply({ ask_id: sent.id, text: 'before claiming' }))).toEqual({
      code: 'forbidden',
    })
    await bob.session.claim(sent.id)
    expect(await errorOf(alice.session.reply({ ask_id: sent.id, text: 'answering myself' }))).toEqual({
      code: 'forbidden',
    })
    expect(await errorOf(alice.session.progress({ ask_id: sent.id, text: 'not mine' }))).toEqual({
      code: 'forbidden',
    })
    expect(await errorOf(alice.session.claim(sent.id))).toEqual({ code: 'ask_taken' })
    await bob.session.reply({ ask_id: sent.id, text: 'me' })
    await alice.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'answered')
  })

  it('only the asking member may cancel; the target holder is told', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'never mind soon' })

    expect(await errorOf(bob.session.cancel(sent.id))).toEqual({ code: 'forbidden' })
    await alice.session.cancel(sent.id)
    const [toAlice, toBob] = await Promise.all([
      alice.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'cancelled'),
      bob.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'cancelled'),
    ])
    expect(toAlice.session_id).toBe(alice.id)
    expect(toBob.session_id).toBe(bob.id)
    expect(await errorOf(bob.session.claim(sent.id))).toEqual({ code: 'ask_closed' })
    expect(await errorOf(alice.session.cancel(sent.id))).toEqual({ code: 'ask_closed' })
  })

  it('only the owner may rotate the invite; the old code stops working', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId, code } = await world.pair(alice, bob)

    const notOwner = bob.client.request('invite.rotate', { session_id: bob.id, room_id: roomId })
    expect(await errorOf(notOwner)).toEqual({ code: 'forbidden' })

    const rotated = await alice.client.request('invite.rotate', { session_id: alice.id, room_id: roomId })
    const fresh = rotated.invite_url?.split('/').at(-1) ?? ''
    expect(fresh).not.toBe(code)

    const carol = await world.peer('carol')
    expect(await errorOf(carol.session.join({ invite_code: code }))).toEqual({ code: 'invite_invalid' })
    const joined = await carol.session.join({ invite_code: fresh, handle: 'helper' })
    expect(joined.handle).toBe('helper')
  })

  it('session-scoped requests for a session on another connection get unknown_session', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    expect(await errorOf(bob.client.request('room.list', { session_id: alice.id }))).toEqual({
      code: 'unknown_session',
    })
  })
})
