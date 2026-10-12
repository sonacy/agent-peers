import { afterEach, describe, expect, it } from 'bun:test'
import { errorCode, type HttpHub, jsonOf, type SignedIn, signIn, startHttpHub } from './support'

let h: HttpHub | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

interface Knock {
  knock_id: string
  state: string
  member: string
  note?: string | null
}

async function scene() {
  h = await startHttpHub()
  const alice = await signIn(h, 'alice')
  const res = await alice.api.post('/v0/me/rooms', { name: 'payments' })
  const roomId = (await jsonOf<{ room: { room_id: string } }>(res)).room.room_id
  await alice.client.request('room.join', { session_id: alice.sessionId, room_id: roomId, handle: 'home' })
  return { hub: h, alice, roomId }
}

async function knock(who: SignedIn, roomId: string, note?: string): Promise<Knock> {
  const res = await who.api.post(`/v0/me/rooms/${roomId}/knock`, note === undefined ? undefined : { note })
  expect(res.status).toBe(201)
  return (await jsonOf<{ knock: Knock }>(res)).knock
}

describe('member API: the knock flow', () => {
  it('knock → owner sees it → accept → the knocker can join', async () => {
    const { hub, alice, roomId } = await scene()
    const carol = await signIn(hub, 'carol')
    const sent = await knock(carol, roomId, 'let me\nask about the API')
    expect(sent).toMatchObject({ state: 'pending', member: 'carol', note: 'let me ask about the API' })

    const search = await jsonOf<{ rooms: { my_state: string }[] }>(
      await carol.api.get('/v0/rooms/search?q=pay'),
    )
    expect(search.rooms[0]?.my_state).toBe('knocking')
    const mine = await jsonOf<{ knocks: Knock[] }>(await carol.api.get('/v0/me/knocks'))
    expect(mine.knocks.map((k) => k.knock_id)).toEqual([sent.knock_id])
    const pending = await carol.api.post(`/v0/me/rooms/${roomId}/knock`)
    expect(pending.status).toBe(409)
    expect(await errorCode(pending)).toBe('knock_pending')

    const rooms = await jsonOf<{ rooms: { pending_knocks: number }[] }>(await alice.api.get('/v0/me/rooms'))
    expect(rooms.rooms[0]?.pending_knocks).toBe(1)
    const detail = await jsonOf<{ knocks: Knock[] }>(await alice.api.get(`/v0/me/rooms/${roomId}`))
    expect(detail.knocks.map((k) => k.knock_id)).toEqual([sent.knock_id])

    const bob = await signIn(hub, 'bob')
    expect((await bob.api.post(`/v0/me/knocks/${sent.knock_id}/decide`, { decision: 'accept' })).status).toBe(
      403,
    )
    const decided = await alice.api.post(`/v0/me/knocks/${sent.knock_id}/decide`, { decision: 'accept' })
    expect(decided.status).toBe(200)
    expect((await jsonOf<{ knock: Knock }>(decided)).knock.state).toBe('accepted')
    expect(await carol.client.waitFor('knock.updated')).toMatchObject({ room_id: roomId, state: 'accepted' })
    const joined = await carol.client.request<{ handle: string }>('room.join', {
      session_id: carol.sessionId,
      room_name: 'payments',
      handle: 'carol',
    })
    expect(joined.handle).toBe('carol')
    const twice = await alice.api.post(`/v0/me/knocks/${sent.knock_id}/decide`, { decision: 'decline' })
    expect(await errorCode(twice)).toBe('invalid_params')
    expect(await errorCode(await carol.api.post(`/v0/me/rooms/${roomId}/knock`))).toBe('already_member')
  })

  it('decline notifies the knocker, who must wait 24 h to knock again', async () => {
    const { hub, alice, roomId } = await scene()
    const dave = await signIn(hub, 'dave')
    const sent = await knock(dave, roomId)
    expect(
      (await alice.api.post(`/v0/me/knocks/${sent.knock_id}/decide`, { decision: 'decline' })).status,
    ).toBe(200)
    expect(await dave.client.waitFor('knock.updated')).toMatchObject({ state: 'declined' })
    const retry = await dave.api.post(`/v0/me/rooms/${roomId}/knock`)
    expect(retry.status).toBe(429)
    expect(await errorCode(retry)).toBe('rate_limited')
    expect(retry.headers.get('retry-after')).toBe(String(24 * 3600))
    expect(
      await errorCode(await alice.api.post(`/v0/me/knocks/${sent.knock_id}/decide`, { decision: 'maybe' })),
    ).toBe('invalid_params')
  })

  it('only the knocker may withdraw', async () => {
    const { hub, alice, roomId } = await scene()
    const erin = await signIn(hub, 'erin')
    const sent = await knock(erin, roomId)
    expect((await alice.api.del(`/v0/me/knocks/${sent.knock_id}`)).status).toBe(403)
    expect((await erin.api.del(`/v0/me/knocks/${sent.knock_id}`)).status).toBe(200)
    const mine = await jsonOf<{ knocks: Knock[] }>(await erin.api.get('/v0/me/knocks'))
    expect(mine.knocks).toEqual([])
    expect(await errorCode(await erin.api.del('/v0/me/knocks/01NOPE00000000000000000000'))).toBe(
      'invalid_params',
    )
  })

  it('cannot knock on a room that is not discoverable', async () => {
    const { hub, alice } = await scene()
    const secret = await jsonOf<{ room: { room_id: string } }>(
      await alice.api.post('/v0/me/rooms', { name: 'secret', discoverable: false }),
    )
    const frank = await signIn(hub, 'frank')
    const res = await frank.api.post(`/v0/me/rooms/${secret.room.room_id}/knock`, { note: 'hi' })
    expect(res.status).toBe(404)
    expect(await errorCode(res)).toBe('room_not_found')
  })
})

describe('member API: PATCH /v0/me/sessions/:id', () => {
  it('patches accepting and title, and the bridge receives session.patched', async () => {
    const { alice } = await scene()
    const res = await alice.api.patch(`/v0/me/sessions/${alice.sessionId}`, { accepting: false })
    expect(res.status).toBe(200)
    expect((await jsonOf<{ session: { accepting: boolean } }>(res)).session.accepting).toBe(false)
    expect(await alice.client.waitFor('session.patched', (p) => p.accepting === false)).toMatchObject({
      session_id: alice.sessionId,
      accepting: false,
    })
    const titled = await alice.api.patch(`/v0/me/sessions/${alice.sessionId}`, { title: '调研 T3Code 项目' })
    expect((await jsonOf<{ session: { title: string } }>(titled)).session.title).toBe('调研 T3Code 项目')
    expect(await alice.client.waitFor('session.patched', (p) => p.title !== undefined)).toMatchObject({
      title: '调研 T3Code 项目',
    })
  })

  it('renames the handle in one room and the session gets handle.renamed', async () => {
    const { alice, roomId } = await scene()
    const res = await alice.api.patch(`/v0/me/sessions/${alice.sessionId}`, {
      handle: 'desk',
      room_id: roomId,
    })
    expect(res.status).toBe(200)
    const card = (await jsonOf<{ session: { rooms: unknown[] } }>(res)).session
    expect(card.rooms).toEqual([{ room_id: roomId, handle: 'desk' }])
    expect(await alice.client.waitFor('handle.renamed')).toMatchObject({
      room_id: roomId,
      old: 'home',
      new: 'desk',
    })
  })

  it("refuses other members' sessions and invalid patches", async () => {
    const { hub, alice } = await scene()
    const bob = await signIn(hub, 'bob')
    const res = await bob.api.patch(`/v0/me/sessions/${alice.sessionId}`, { accepting: false })
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('forbidden')
    expect(
      await errorCode(await alice.api.patch(`/v0/me/sessions/${alice.sessionId}`, { room_id: 'x' })),
    ).toBe('invalid_params')
    expect(
      await errorCode(await alice.api.patch(`/v0/me/sessions/${alice.sessionId}`, { handle: 'Nope!' })),
    ).toBe('invalid_name')
    const unknown = await alice.api.patch('/v0/me/sessions/01NOPE00000000000000000000', { accepting: true })
    expect(unknown.status).toBe(404)
    expect(await errorCode(unknown)).toBe('unknown_session')
  })
})
