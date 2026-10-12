import { afterEach, describe, expect, it } from 'bun:test'
import { MAX_OPEN_ASKS_PER_ASKER_TARGET, MAX_OPEN_ASKS_PER_TARGET, MAX_TEXT_BYTES } from '@agent-peers/core'
import { eventually } from './support/inbox'
import { errorOf, GRACE_MS, type Peer, startWorld, type World } from './support/world'

const MINUTE_MS = 60_000
let world: World | undefined

afterEach(async () => {
  await world?.stop()
  world = undefined
})

async function askers(w: World, count: number, code: string): Promise<readonly Peer[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const peer = await w.peer(`asker${i}`)
      await peer.session.join({ invite_code: code, handle: `asker${i}` })
      return peer
    }),
  )
}

describe('L2: limits', () => {
  it('caps open asks per (asker, target) with rate_limited and per target with target_busy', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId, code } = await world.pair(alice, bob)

    for (let i = 0; i < MAX_OPEN_ASKS_PER_ASKER_TARGET; i += 1)
      await alice.session.ask({ room_id: roomId, to: 'work', text: `q${i}` })
    const capped = await errorOf(alice.session.ask({ room_id: roomId, to: 'work', text: 'one more' }))
    expect(capped.code).toBe('rate_limited')

    const needed = Math.ceil(
      (MAX_OPEN_ASKS_PER_TARGET - MAX_OPEN_ASKS_PER_ASKER_TARGET) / MAX_OPEN_ASKS_PER_ASKER_TARGET,
    )
    const others = await askers(world, needed, code)
    let open = MAX_OPEN_ASKS_PER_ASKER_TARGET
    for (const peer of others) {
      for (let i = 0; i < MAX_OPEN_ASKS_PER_ASKER_TARGET && open < MAX_OPEN_ASKS_PER_TARGET; i += 1) {
        await peer.session.ask({ room_id: roomId, to: 'work', text: `from ${peer.member}` })
        open += 1
      }
    }
    const last = others.at(-1) as Peer
    const busy = await errorOf(last.session.ask({ room_id: roomId, to: 'work', text: 'too many' }))
    expect(busy.code).toBe('target_busy')
  })

  it('rejects oversize text with payload_too_large, in the client and at the hub', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const big = 'x'.repeat(MAX_TEXT_BYTES + 1)

    const sentBefore = alice.tap.sentOf('msg.send').length
    expect(await errorOf(alice.session.send({ room_id: roomId, text: big }))).toEqual({
      code: 'payload_too_large',
    })
    expect(alice.tap.sentOf('msg.send')).toHaveLength(sentBefore)

    const raw = alice.client.request('msg.send', {
      session_id: alice.id,
      client_msg_id: 'raw-big-1',
      room_id: roomId,
      kind: 'chat',
      text: big,
    })
    expect(await errorOf(raw)).toEqual({ code: 'payload_too_large' })
    expect(alice.client.state).toBe('connected')
  })

  it('rate-limits messages per member with retry_after_ms, and recovers after the window', async () => {
    world = await startWorld({ messagesPerMinute: 3, heartbeatMs: 10 * MINUTE_MS })
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    for (let i = 0; i < 3; i += 1) await alice.session.send({ room_id: roomId, text: `m${i}` })

    const limited = await errorOf(alice.session.send({ room_id: roomId, text: 'm3' }))
    expect(limited).toEqual({ code: 'rate_limited', retryAfterMs: MINUTE_MS })
    world.clock.advance(MINUTE_MS)
    const ok = await alice.session.send({ room_id: roomId, text: 'm3' })
    expect(ok.seq).toBeGreaterThan(0)
  })

  it('expires asks past their ttl; both sides are told and claims get ask_closed', async () => {
    world = await startWorld({ sweepIntervalMs: 500 })
    const alice = await world.peer('alice')
    const bob = await world.peer('bob')
    const { roomId } = await world.pair(alice, bob)
    const sent = await alice.session.ask({ room_id: roomId, to: 'work', text: 'quick one', ttl_ms: 1000 })
    await bob.inbox.waitFor('msg.new', (n) => n.message.id === sent.id)

    world.clock.advance(1500)
    const [toAlice, toBob] = await Promise.all([
      alice.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'expired'),
      bob.inbox.waitFor('ask.updated', (n) => n.ask_id === sent.id && n.state === 'expired'),
    ])
    expect(toAlice.reason).toBe('expired')
    expect(toBob.reason).toBe('expired')
    expect(await errorOf(bob.session.claim(sent.id))).toEqual({ code: 'ask_closed' })
  })

  it('a working ask fails with target_lost once its assignee is gone for grace_ms', async () => {
    world = await startWorld()
    const alice = await world.peer('alice')
    const bob = await world.peer('bob', { reconnect: false })
    const { roomId } = await world.pair(alice, bob)
    const bobId = bob.id
    const working = await alice.session.ask({ room_id: roomId, to: 'work', text: 'long job' })
    const delivered = await alice.session.ask({ room_id: roomId, to: 'work', text: 'not started' })
    await bob.session.claim(working.id)

    bob.tap.crash()
    await eventually(() => world?.sessionRow(bobId)?.connection === 'stale', 'stale')
    expect(alice.inbox.all('ask.updated', (n) => n.ask_id === working.id && n.state === 'failed')).toEqual([])

    world.clock.advance(GRACE_MS)
    const lost = await alice.inbox.waitFor(
      'ask.updated',
      (n) => n.ask_id === working.id && n.state === 'failed',
    )
    expect(lost.reason).toBe('target_lost')
    const requeued = await alice.inbox.waitFor(
      'ask.updated',
      (n) => n.ask_id === delivered.id && n.state === 'queued',
    )
    expect(requeued.reason).toBeUndefined()

    const offline = alice.session.ask({ room_id: roomId, to: 'work', text: 'now?', require_online: true })
    expect(await errorOf(offline)).toEqual({ code: 'target_offline' })
  })
})
