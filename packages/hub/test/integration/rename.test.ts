import { afterEach, describe, expect, it } from 'bun:test'
import { startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

describe('L2: rename', () => {
  it('a title rename produces presence.changed for the room and session.patched for the session', async () => {
    world = await startWorld()
    const alice = await world.peer('alice', { title: 'old title' })
    const bob = await world.peer('bob')
    await world.pair(alice, bob)

    const result = await alice.session.rename({ title: '新的标题' })
    expect(result).toEqual({ title: '新的标题', rooms: [] })
    expect(alice.session.view.card.title).toBe('新的标题')

    const changed = await bob.inbox.waitFor('presence.changed', (n) => n.card.title === '新的标题')
    expect(changed.handle).toBe('home')
    const patched = await alice.inbox.waitFor('session.patched', (n) => n.title === '新的标题')
    expect(patched.session_id).toBe(alice.id)
  })

  it('a handle rename logs a system message and re-addresses an open ask, which stays claimable', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'still there?' })
    await bob.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)

    const result = await bob.session.rename({ handle: 'worker' })
    expect(result.rooms).toEqual([{ room_id: roomId, old: 'work', new: 'worker' }])
    expect(bob.session.view.rooms[0]?.handle).toBe('worker')

    const system = await alice.inbox.waitFor('msg.new', (n) => n.message.text === '@work is now @worker')
    expect(system.message).toMatchObject({ kind: 'system', room_id: roomId })
    const renamed = await bob.inbox.waitFor('handle.renamed', (n) => n.new === 'worker')
    expect(renamed).toMatchObject({ room_id: roomId, old: 'work', by: { session_id: bob.id } })
    await alice.inbox.waitFor('presence.changed', (n) => n.handle === 'worker')

    const claimed = await bob.session.claim(sent.id)
    expect(claimed.ask).toMatchObject({ state: 'working', to_handle: 'worker' })
    await bob.session.reply({ ask_id: sent.id, text: 'yes' })
    await alice.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'answered')

    const taken = await alice.session.rename({ handle: 'worker' }).catch((e: { code: string }) => e.code)
    expect(taken).toBe('rename_conflict')
  })

  it('renaming the asker keeps replies routed to the new handle', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'ping' })
    await bob.session.claim(sent.id)

    await alice.session.rename({ handle: 'house', room_id: roomId })
    const reply = await bob.session.reply({ ask_id: sent.id, text: 'pong' })
    const got = await alice.inbox.waitFor('msg.new', (n) => n.message.id === reply.id)
    expect(got.message.to).toEqual(['house'])
    await alice.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'answered')
    expect((await bob.session.getAsk(sent.id)).ask.from_handle).toBe('house')
  })

  it('an owner rename sends handle.renamed to the renamed session, which updates its view', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)

    const owner = { kind: 'member', memberId: alice.memberId } as const
    world.hub.services.rename.renameHandle(owner, roomId, 'work', 'reviewer')

    const renamed = await bob.inbox.waitFor('handle.renamed', (n) => n.new === 'reviewer')
    expect(renamed).toMatchObject({ room_id: roomId, old: 'work', by: { member: 'alice' } })
    expect(bob.session.view.rooms).toEqual([{ room_id: roomId, handle: 'reviewer', name: 'team' }])
    const listed = await alice.session.peers(roomId)
    expect(listed.members.map((m) => m.handle).sort()).toEqual(['home', 'reviewer'])

    const outsider = { kind: 'member', memberId: bob.memberId } as const
    expect(() => world?.hub.services.rename.renameHandle(outsider, roomId, 'home', 'boss')).toThrow(
      'only the owner may rename',
    )
  })
})

describe('L2: session.patched from the dashboard service', () => {
  it('toggling accepting reaches the client and updates its card', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    await world.pair(alice, bob)
    expect(bob.session.view.card.accepting).toBeUndefined()

    const self = { kind: 'member', memberId: bob.memberId } as const
    const card = world.hub.services.rename.patch(self, bob.id, { accepting: false })
    expect(card.accepting).toBe(false)

    const patched = await bob.inbox.waitFor('session.patched', (n) => n.accepting === false)
    expect(patched.session_id).toBe(bob.id)
    expect(bob.session.view.card.accepting).toBe(false)
    const seen = await alice.inbox.waitFor('presence.changed', (n) => n.card.accepting === false)
    expect(seen.handle).toBe('work')

    world.hub.services.rename.patch(self, bob.id, { accepting: true })
    await bob.inbox.waitFor('session.patched', (n) => n.accepting === true)
    expect(bob.session.view.card.accepting).toBe(true)

    const stranger = { kind: 'member', memberId: alice.memberId } as const
    expect(() => world?.hub.services.rename.patch(stranger, bob.id, { accepting: false })).toThrow(
      'not your session',
    )
  })
})
