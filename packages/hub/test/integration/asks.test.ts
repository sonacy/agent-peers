import { afterEach, describe, expect, it } from 'bun:test'
import type { Peer } from './support/world'
import { startWorld, type World } from './support/world'

let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

/** Target side of an ask: wait for the offer, claim, report progress and reply. */
async function answer(target: Peer, askId: string, text: string): Promise<void> {
  const offered = await target.inbox.waitFor('msg.new', (n) => n.message.id === askId)
  expect(offered.message.kind).toBe('ask')
  expect(offered.message.ask?.state).toBe('delivered')
  const claimed = await target.session.claim(askId)
  expect(claimed.ask).toMatchObject({ state: 'working', assignee_session: target.id })
  await target.session.progress({ ask_id: askId, text: 'looking' })
  await target.session.reply({ ask_id: askId, text })
}

describe('L2: ask A → B', () => {
  it('delivers, claims, works and replies; the asker gets the reply and ask.updated answered', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)

    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'retry policy?' })
    expect(sent.ask?.state).toBe('delivered')

    const offered = await bob.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)
    expect(offered.message).toMatchObject({ to: ['work'], meta: { mode: 'read' }, text: 'retry policy?' })

    const claimed = await bob.session.claim(sent.id)
    expect(claimed.ask.state).toBe('working')
    await alice.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'working')
    const again = await bob.session.claim(sent.id)
    expect(again.ask.state).toBe('working')

    await bob.session.progress({ ask_id: sent.id, text: 'reading the client' })
    const progress = await alice.inbox.waitFor('msg.new', (n) => n.message.kind === 'progress')
    expect(progress.message.re).toBe(sent.id)

    const reply = await bob.session.reply({ ask_id: sent.id, text: 'exponential, 5 tries' })
    const updated = await alice.inbox.waitFor(
      'ask.updated',
      (n) => n.ask_id === sent.id && n.state === 'answered',
    )
    expect(updated.reason).toBeUndefined()
    const got = await alice.inbox.waitFor('msg.new', (n) => n.message.id === reply.id)
    expect(got.message).toMatchObject({
      kind: 'reply',
      re: sent.id,
      to: ['home'],
      text: 'exponential, 5 tries',
    })

    const full = await alice.session.getAsk(sent.id)
    expect(full.ask).toMatchObject({ state: 'answered', from_handle: 'home', to_handle: 'work' })
    expect(full.messages.map((m) => m.kind)).toEqual(['ask', 'progress', 'reply'])

    const closed = await bob.session.claim(sent.id).catch((e: { code: string }) => e.code)
    expect(closed).toBe('ask_closed')
  })

  it('a declined reply closes the ask as declined', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'rm -rf?', mode: 'write' })
    await bob.session.claim(sent.id)
    await bob.session.reply({ ask_id: sent.id, text: 'no', state: 'declined' })
    const updated = await alice.inbox.waitFor('ask.updated', (n) => n.state === 'declined')
    expect(updated.ask_id).toBe(sent.id)
  })
})

describe('L2: cross asks A → B and B → A concurrently', () => {
  it('runs both asks to completion without interference', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)

    const [toBob, toAlice] = await Promise.all([
      alice.session.ask({ room_id: roomId, to: 'work', text: 'A asks B' }),
      bob.session.ask({ room_id: roomId, to: 'home', text: 'B asks A' }),
    ])
    expect(toBob.id).not.toBe(toAlice.id)

    await Promise.all([answer(bob, toBob.id, 'B answers A'), answer(alice, toAlice.id, 'A answers B')])

    const [aliceDone, bobDone] = await Promise.all([
      alice.inbox.waitFor('ask.updated', (n) => n.ask_id === toBob.id && n.state === 'answered'),
      bob.inbox.waitFor('ask.updated', (n) => n.ask_id === toAlice.id && n.state === 'answered'),
    ])
    expect(aliceDone.session_id).toBe(alice.id)
    expect(bobDone.session_id).toBe(bob.id)

    const aliceReply = await alice.inbox.waitFor(
      'msg.new',
      (n) => n.message.re === toBob.id && n.message.kind === 'reply',
    )
    const bobReply = await bob.inbox.waitFor(
      'msg.new',
      (n) => n.message.re === toAlice.id && n.message.kind === 'reply',
    )
    expect(aliceReply.message.text).toBe('B answers A')
    expect(bobReply.message.text).toBe('A answers B')
    // Neither side was told about the other ask's terminal state.
    expect(alice.inbox.all('ask.updated', (n) => n.ask_id === toAlice.id && n.state === 'answered')).toEqual(
      [],
    )
    expect(bob.inbox.all('ask.updated', (n) => n.ask_id === toBob.id && n.state === 'answered')).toEqual([])
  })
})
