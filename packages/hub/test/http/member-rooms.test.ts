import { afterEach, describe, expect, it } from 'bun:test'
import { caller, errorCode, type HttpHub, jsonOf, type SignedIn, signIn, startHttpHub } from './support'

let h: HttpHub | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

interface Created {
  room: { room_id: string; name: string; owner?: string }
  invite: { state: string; code_masked: string }
  invite_url: string
  join_prompt: string
}

async function createRoom(
  owner: SignedIn,
  name = 'payments',
  extra: Record<string, unknown> = {},
): Promise<Created> {
  const res = await owner.api.post('/v0/me/rooms', { name, description: 'the team', ...extra })
  expect(res.status).toBe(201)
  return jsonOf<Created>(res)
}

/** alice owns `payments`; bob redeemed its invite; both have a session holding a handle in it. */
async function scene() {
  h = await startHttpHub()
  const alice = await signIn(h, 'alice')
  const bob = await signIn(h, 'bob')
  const created = await createRoom(alice)
  const roomId = created.room.room_id
  const code = created.invite_url.split('/').at(-1) ?? ''
  await alice.client.request('room.join', { session_id: alice.sessionId, room_id: roomId, handle: 'home' })
  await bob.client.request('room.join', { session_id: bob.sessionId, invite_code: code, handle: 'work' })
  return { hub: h, alice, bob, roomId, code, created }
}

describe('member API: auth and reads', () => {
  it('requires the member cookie on every member endpoint', async () => {
    h = await startHttpHub()
    const anon = caller(h.base)
    for (const path of ['/v0/me', '/v0/me/sessions', '/v0/me/rooms', '/v0/me/asks', '/v0/rooms/search?q=a']) {
      const res = await anon.get(path)
      expect(res.status).toBe(401)
      expect(await errorCode(res)).toBe('unauthorized')
    }
    expect((await caller(h.base, 'ap_member=apw_forged').get('/v0/me')).status).toBe(401)
    expect((await anon.post('/v0/me/rooms', { name: 'x' })).status).toBe(401)
  })

  it('never accepts a member token in the URL or as a bearer header', async () => {
    h = await startHttpHub()
    const alice = await signIn(h, 'alice')
    expect((await caller(h.base).get(`/v0/me?token=${alice.token}`)).status).toBe(401)
    const bearer = await caller(h.base).get('/v0/me', { headers: { authorization: `Bearer ${alice.token}` } })
    expect(bearer.status).toBe(401)
  })

  it('returns me, my sessions, my rooms and room detail with owner extras', async () => {
    const { alice, bob, roomId } = await scene()
    const me = await jsonOf<{ member_id: string; name: string }>(await alice.api.get('/v0/me'))
    expect(me).toMatchObject({ member_id: alice.memberId, name: 'alice' })

    const sessions = await jsonOf<{ sessions: { session_id: string; rooms: unknown[] }[] }>(
      await alice.api.get('/v0/me/sessions'),
    )
    expect(sessions.sessions.map((s) => s.session_id)).toEqual([alice.sessionId])
    expect(sessions.sessions[0]?.rooms).toEqual([{ room_id: roomId, handle: 'home' }])

    const rooms = await jsonOf<{
      rooms: { role: string; people: number; agents: number; pending_knocks?: number }[]
    }>(await alice.api.get('/v0/me/rooms'))
    expect(rooms.rooms).toHaveLength(1)
    expect(rooms.rooms[0]).toMatchObject({ role: 'owner', people: 2, agents: 2, pending_knocks: 0 })

    const owner = await jsonOf<Record<string, unknown>>(await alice.api.get(`/v0/me/rooms/${roomId}`))
    expect(owner.my_role).toBe('owner')
    expect(owner.invite).toMatchObject({ state: 'active' })
    expect(String(owner.join_prompt)).toContain('/install.sh')
    expect(owner.knocks).toEqual([])
    expect(owner.kicked).toEqual([])
    const people = owner.people as { member: string; is_me: boolean; agents: { handle: string }[] }[]
    expect(people.map((p) => [p.member, p.is_me])).toEqual([
      ['alice', true],
      ['bob', false],
    ])

    const member = await jsonOf<Record<string, unknown>>(await bob.api.get(`/v0/me/rooms/${roomId}`))
    expect(member.my_role).toBe('member')
    expect(member.invite).toBeUndefined()
    expect(member.join_prompt).toBeUndefined()
    expect(member.knocks).toBeUndefined()
  })

  it('hides rooms the member has no grant for and validates ids', async () => {
    const { roomId, hub } = await scene()
    const carol = await signIn(hub, 'carol')
    const res = await carol.api.get(`/v0/me/rooms/${roomId}`)
    expect(res.status).toBe(403)
    expect(await errorCode(await carol.api.get('/v0/me/rooms/01NOPE0000000000000000000'))).toBe(
      'room_not_found',
    )
    expect(await errorCode(await carol.api.get('/v0/me/rooms/bad%20id'))).toBe('invalid_params')
  })

  it('pages the Q&A feed with filter and cursor', async () => {
    const { alice, bob, roomId } = await scene()
    for (let i = 0; i < 3; i++) {
      await bob.client.request('msg.send', {
        session_id: bob.sessionId,
        client_msg_id: `01JD000000000000000000000${i}`,
        room_id: roomId,
        kind: 'ask',
        to: ['home'],
        text: `question ${i}`,
      })
    }
    const all = await jsonOf<{ asks: { question: { text: string } }[]; next_cursor: string | null }>(
      await alice.api.get('/v0/me/asks'),
    )
    expect(all.asks.map((a) => a.question.text)).toEqual(['question 2', 'question 1', 'question 0'])
    expect(all.next_cursor).toBeNull()
    const toMe = await jsonOf<{ asks: unknown[] }>(await alice.api.get('/v0/me/asks?filter=to_me'))
    expect(toMe.asks).toHaveLength(3)
    const mine = await jsonOf<{ asks: unknown[] }>(await alice.api.get('/v0/me/asks?filter=mine'))
    expect(mine.asks).toHaveLength(0)
    const bobs = await jsonOf<{ asks: unknown[] }>(await bob.api.get('/v0/me/asks?filter=mine'))
    expect(bobs.asks).toHaveLength(3)
    expect(await errorCode(await alice.api.get('/v0/me/asks?filter=nope'))).toBe('invalid_params')
  })

  it('searches discoverable rooms only', async () => {
    const { hub, alice } = await scene()
    await createRoom(alice, 'secret', { discoverable: false })
    const carol = await signIn(hub, 'carol')
    const found = await jsonOf<{
      rooms: { name: string; owner: string; member_count: number; my_state: string }[]
    }>(await carol.api.get('/v0/rooms/search?q=pay'))
    expect(found.rooms).toEqual([
      expect.objectContaining({ name: 'payments', owner: 'alice', member_count: 2, my_state: 'none' }),
    ])
    const secret = await jsonOf<{ rooms: unknown[] }>(await carol.api.get('/v0/rooms/search?q=secret'))
    expect(secret.rooms).toEqual([])
    expect(await errorCode(await carol.api.get(`/v0/rooms/search?q=${'x'.repeat(101)}`))).toBe(
      'invalid_params',
    )
  })
})

describe('member API: owner-only room management', () => {
  it('creates a room with its invite, and refuses invalid or taken names', async () => {
    h = await startHttpHub()
    const alice = await signIn(h, 'alice')
    const created = await createRoom(alice, 'payments', { display_name: '支付联调' })
    expect(created.room).toMatchObject({ name: 'payments', owner: 'alice', display_name: '支付联调' })
    expect(created.invite.code_masked).toStartWith('inv_')
    expect(created.invite_url).toMatch(/\/j\/[0-9A-Z]{16}$/)
    expect(created.join_prompt).toContain(created.invite_url)
    expect(await errorCode(await alice.api.post('/v0/me/rooms', { name: 'payments' }))).toBe('invalid_name')
    expect(await errorCode(await alice.api.post('/v0/me/rooms', { name: 'Bad Name' }))).toBe('invalid_name')
    expect(await errorCode(await alice.api.post('/v0/me/rooms', {}))).toBe('invalid_params')
  })

  it('rotates, closes and reopens the invite (owner only)', async () => {
    const { alice, bob, roomId, code } = await scene()
    const denied = await bob.api.post(`/v0/me/rooms/${roomId}/invite/rotate`)
    expect(denied.status).toBe(403)
    expect(await errorCode(denied)).toBe('forbidden')

    const rotated = await jsonOf<{ invite: { state: string }; invite_url: string; join_prompt: string }>(
      await alice.api.post(`/v0/me/rooms/${roomId}/invite/rotate`),
    )
    expect(rotated.invite.state).toBe('active')
    expect(rotated.invite_url).not.toContain(code)
    expect(rotated.join_prompt).toContain(rotated.invite_url)

    const closed = await jsonOf<{ invite: { state: string }; invite_url: null }>(
      await alice.api.post(`/v0/me/rooms/${roomId}/invite/close`),
    )
    expect(closed).toEqual(expect.objectContaining({ invite_url: null, join_prompt: null }))
    expect(closed.invite.state).toBe('closed')

    const reopened = await jsonOf<{ invite: { state: string }; invite_url: string }>(
      await alice.api.post(`/v0/me/rooms/${roomId}/invite/reopen`),
    )
    expect(reopened.invite.state).toBe('active')
    expect(await errorCode(await alice.api.post(`/v0/me/rooms/${roomId}/invite/explode`))).toBe(
      'invalid_params',
    )
  })

  it('removes an agent: its own member or the owner, nobody else', async () => {
    const { hub, alice, bob, roomId } = await scene()
    const carol = await signIn(hub, 'carol')
    expect((await carol.api.del(`/v0/me/rooms/${roomId}/sessions/${bob.sessionId}`)).status).toBe(403)
    const res = await alice.api.del(`/v0/me/rooms/${roomId}/sessions/${bob.sessionId}`)
    expect(res.status).toBe(200)
    const removed = await bob.client.waitFor('room.removed')
    expect(removed).toMatchObject({ room_id: roomId, reason: 'removed' })
    expect(hub.hub.services.access.activeGrant(roomId, bob.memberId)).toBeDefined()
    const again = await bob.api.del(`/v0/me/rooms/${roomId}/sessions/${bob.sessionId}`)
    expect(await errorCode(again)).toBe('target_not_found')
    expect((await alice.api.del(`/v0/me/rooms/${roomId}/sessions/${alice.sessionId}`)).status).toBe(200)
  })

  it('kicks and restores a member (owner only), by name or id', async () => {
    const { alice, bob, roomId } = await scene()
    expect((await bob.api.del(`/v0/me/rooms/${roomId}/grants/alice`)).status).toBe(403)
    expect((await alice.api.del(`/v0/me/rooms/${roomId}/grants/bob`)).status).toBe(200)
    expect(await bob.client.waitFor('kicked')).toMatchObject({ room_id: roomId })
    expect((await bob.api.get(`/v0/me/rooms/${roomId}`)).status).toBe(403)
    const detail = await jsonOf<{ kicked: { member: string }[] }>(
      await alice.api.get(`/v0/me/rooms/${roomId}`),
    )
    expect(detail.kicked.map((k) => k.member)).toEqual(['bob'])
    expect(await errorCode(await alice.api.del(`/v0/me/rooms/${roomId}/grants/bob`))).toBe('target_not_found')

    expect((await bob.api.post(`/v0/me/rooms/${roomId}/restore/bob`)).status).toBe(403)
    expect((await alice.api.post(`/v0/me/rooms/${roomId}/restore/${bob.memberId}`)).status).toBe(200)
    expect((await bob.api.get(`/v0/me/rooms/${roomId}`)).status).toBe(200)
    expect(await errorCode(await alice.api.post(`/v0/me/rooms/${roomId}/restore/bob`))).toBe(
      'target_not_found',
    )
  })

  it('lets a member exit but makes the owner dissolve instead', async () => {
    const { alice, bob, roomId } = await scene()
    expect(await errorCode(await alice.api.post(`/v0/me/rooms/${roomId}/exit`))).toBe('forbidden')
    expect((await bob.api.post(`/v0/me/rooms/${roomId}/exit`)).status).toBe(200)
    expect(await bob.client.waitFor('room.removed')).toMatchObject({ room_id: roomId })
    const rooms = await jsonOf<{ rooms: unknown[] }>(await bob.api.get('/v0/me/rooms'))
    expect(rooms.rooms).toEqual([])
  })

  it('dissolves a room (owner only)', async () => {
    const { alice, bob, roomId } = await scene()
    expect((await bob.api.del(`/v0/me/rooms/${roomId}`)).status).toBe(403)
    expect((await alice.api.del(`/v0/me/rooms/${roomId}`)).status).toBe(200)
    expect(await bob.client.waitFor('room.removed')).toMatchObject({ room_id: roomId, reason: 'dissolved' })
    const gone = await alice.api.get(`/v0/me/rooms/${roomId}`)
    expect(gone.status).toBe(404)
    expect(await errorCode(gone)).toBe('room_not_found')
  })

  it('checks Origin on every cookie-authenticated mutation', async () => {
    const { alice, roomId } = await scene()
    const cross = caller(h?.base ?? '', alice.cookie, 'https://evil.example')
    const missing = caller(h?.base ?? '', alice.cookie, null)
    for (const api of [cross, missing]) {
      expect((await api.post('/v0/me/rooms', { name: 'evil' })).status).toBe(403)
      expect((await api.del(`/v0/me/rooms/${roomId}`)).status).toBe(403)
      expect((await api.patch(`/v0/me/sessions/${alice.sessionId}`, { accepting: false })).status).toBe(403)
    }
    expect((await missing.get('/v0/me')).status).toBe(200)
  })
})
