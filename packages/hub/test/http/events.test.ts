import { afterEach, describe, expect, it } from 'bun:test'
import { caller, type HttpHub, jsonOf, openEvents, readEvents, signIn, startHttpHub } from './support'

let h: HttpHub | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

const KEEPALIVE_MS = 5000

async function scene() {
  h = await startHttpHub({ http: { sseKeepaliveMs: KEEPALIVE_MS } })
  const alice = await signIn(h, 'alice')
  const bob = await signIn(h, 'bob')
  const carol = await signIn(h, 'carol')
  const created = await jsonOf<{ room: { room_id: string }; invite_url: string }>(
    await alice.api.post('/v0/me/rooms', { name: 'payments' }),
  )
  const roomId = created.room.room_id
  const code = created.invite_url.split('/').at(-1) ?? ''
  await alice.client.request('room.join', { session_id: alice.sessionId, room_id: roomId, handle: 'home' })
  await bob.client.request('room.join', { session_id: bob.sessionId, invite_code: code, handle: 'work' })
  return { hub: h, alice, bob, carol, roomId }
}

function chat(
  from: { client: { request: (m: string, p: unknown) => Promise<unknown> }; sessionId: string },
  roomId: string,
  text: string,
) {
  return from.client.request('msg.send', {
    session_id: from.sessionId,
    client_msg_id: `01JE${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(22, '0')}`,
    room_id: roomId,
    kind: 'chat',
    text,
  })
}

describe('GET /v0/me/events (SSE)', () => {
  it('requires the cookie', async () => {
    h = await startHttpHub()
    expect((await caller(h.base).get('/v0/me/events')).status).toBe(401)
  })

  it('delivers events scoped to what the member can see', async () => {
    const { alice, carol, bob, roomId } = await scene()
    const aliceStream = await alice.api.get('/v0/me/events')
    expect(aliceStream.status).toBe(200)
    expect(aliceStream.headers.get('content-type')).toContain('text/event-stream')
    const carolStream = await carol.api.get('/v0/me/events')

    await chat(bob, roomId, 'hello room')
    // carol (outside the room) knocks, so her stream provably moved past the chat.
    await carol.api.post(`/v0/me/rooms/${roomId}/knock`, { note: 'hi' })

    const aliceEvents = await readEvents(aliceStream, (es) => es.some((e) => e.event === 'knock'))
    const message = aliceEvents.find((e) => e.event === 'message')
    expect(JSON.parse(message?.data ?? '{}').message.text).toBe('hello room')
    expect(aliceEvents.some((e) => e.event === 'knock')).toBe(true)

    const carolEvents = await readEvents(carolStream, (es) => es.some((e) => e.event === 'knock'))
    expect(carolEvents.some((e) => e.event === 'knock')).toBe(true)
    expect(carolEvents.some((e) => e.event === 'message')).toBe(false)
    expect(carolEvents.some((e) => e.event === 'presence')).toBe(false)
  })

  it('carries session events to the owning member only', async () => {
    const { alice, bob } = await scene()
    const bobStream = await bob.api.get('/v0/me/events')
    const aliceStream = await alice.api.get('/v0/me/events')
    await alice.api.patch(`/v0/me/sessions/${alice.sessionId}`, { title: 'refactoring' })
    await bob.api.patch(`/v0/me/sessions/${bob.sessionId}`, { title: 'bob marker' })
    const aliceEvents = await readEvents(aliceStream, (es) =>
      es.some((e) => e.event === 'session' && e.data.includes('refactoring')),
    )
    expect(aliceEvents.some((e) => e.event === 'session' && e.data.includes('refactoring'))).toBe(true)
    const bobEvents = await readEvents(bobStream, (es) => es.some((e) => e.data.includes('bob marker')))
    expect(bobEvents.some((e) => e.event === 'session' && e.data.includes('refactoring'))).toBe(false)
    // bob does see alice's presence in the shared room.
    expect(bobEvents.some((e) => e.event === 'presence' && e.data.includes('refactoring'))).toBe(true)
  })

  it('sends keep-alive comments on the hub clock and ends after logout', async () => {
    const { alice, bob, roomId, hub } = await scene()
    const stream = openEvents(await alice.api.get('/v0/me/events'))
    hub.clock.advance(KEEPALIVE_MS)
    const first = await stream.until((es) => es.some((e) => e.data.includes('keepalive')), 1000)
    expect(first.some((e) => e.data.includes('keepalive'))).toBe(true)

    await alice.api.post('/v0/me/logout')
    await chat(bob, roomId, 'after logout')
    const after = await stream.until((es) => es.some((e) => e.event === 'message'), 300)
    expect(after.some((e) => e.event === 'message')).toBe(false)
    await stream.close()
  })

  it('closes open streams when the hub stops', async () => {
    const { alice } = await scene()
    const stream = await alice.api.get('/v0/me/events')
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await h?.stop()
    h = undefined
    let done = false
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read().catch(() => ({ done: true }))).done
    expect(done).toBe(true)
  })
})
