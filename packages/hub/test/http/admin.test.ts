import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADMIN_TOKEN_FILE } from '../../src/bootstrap'
import {
  caller,
  cookiePair,
  errorCode,
  type HttpHub,
  jsonOf,
  readEvents,
  signIn,
  startHttpHub,
} from './support'

let h: HttpHub | undefined
const dirs: string[] = []

afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function adminLogin(hub: HttpHub, token = hub.info.adminToken) {
  const res = await caller(hub.adminBase).post('/v0/admin/login', { token })
  expect(res.status).toBe(200)
  const cookie = cookiePair(res)
  return { res, cookie, api: caller(hub.adminBase, cookie) }
}

describe('admin auth', () => {
  it('exchanges the admin token for a strict HttpOnly cookie, with Origin checked', async () => {
    h = await startHttpHub()
    const anon = caller(h.adminBase)
    expect((await anon.get('/v0/admin/status')).status).toBe(401)
    expect(await errorCode(await anon.post('/v0/admin/login', { token: 'apa_wrong' }))).toBe('unauthorized')
    expect(
      (await caller(h.adminBase, undefined, null).post('/v0/admin/login', { token: h.info.adminToken }))
        .status,
    ).toBe(403)
    const foreign = caller(h.adminBase, undefined, 'http://evil.example')
    expect((await foreign.post('/v0/admin/login', { token: h.info.adminToken })).status).toBe(403)

    const { res, api } = await adminLogin(h)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('ap_admin=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('Secure')
    expect(res.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    expect((await api.get('/v0/admin/whoami')).status).toBe(200)

    expect((await api.post('/v0/admin/logout')).status).toBe(200)
    expect((await api.get('/v0/admin/status')).status).toBe(401)
  })

  it('never accepts the token in the URL; scripts may use a bearer header without Origin', async () => {
    h = await startHttpHub()
    expect((await caller(h.adminBase).get(`/v0/admin/status?token=${h.info.adminToken}`)).status).toBe(401)
    const bearer = caller(h.adminBase, undefined, null)
    const auth = { headers: { authorization: `Bearer ${h.info.adminToken}` } }
    expect((await bearer.get('/v0/admin/status', auth)).status).toBe(200)
    expect((await bearer.post('/v0/admin/rooms', { name: 'ops' }, auth)).status).toBe(201)
    expect(
      (await bearer.get('/v0/admin/status', { headers: { authorization: 'Bearer apa_wrong_token' } })).status,
    ).toBe(401)
  })

  it('refuses cookie mutations without a matching Origin', async () => {
    h = await startHttpHub()
    const { cookie } = await adminLogin(h)
    expect((await caller(h.adminBase, cookie, null).post('/v0/admin/rooms', { name: 'ops' })).status).toBe(
      403,
    )
    expect(
      (await caller(h.adminBase, cookie, 'http://evil.example').patch('/v0/admin/settings', {})).status,
    ).toBe(403)
  })

  it('rotates the admin token, persists it and signs other browsers out', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-peers-admin-'))
    dirs.push(dataDir)
    h = await startHttpHub({ dataDir })
    const first = await adminLogin(h)
    const second = await adminLogin(h)
    const res = await first.api.post('/v0/admin/rotate-admin-token')
    expect(res.status).toBe(200)
    const body = await jsonOf<{ admin_token: string; persisted: boolean }>(res)
    expect(body.admin_token).toStartWith('apa_')
    expect(body.admin_token).not.toBe(h.info.adminToken)
    expect(body.persisted).toBe(true)
    expect((await readFile(join(dataDir, ADMIN_TOKEN_FILE), 'utf8')).trim()).toBe(body.admin_token)
    expect(h.hub.services.auth.verifyAdmin(h.info.adminToken)).toBe(false)
    expect((await second.api.get('/v0/admin/status')).status).toBe(401)
    const renewed = caller(h.adminBase, cookiePair(res))
    expect((await renewed.get('/v0/admin/status')).status).toBe(200)
    expect(
      await errorCode(await caller(h.adminBase).post('/v0/admin/login', { token: h.info.adminToken })),
    ).toBe('unauthorized')
  })

  it('reports an in-memory rotation as not persisted', async () => {
    h = await startHttpHub()
    const { api } = await adminLogin(h)
    const body = await jsonOf<{ persisted: boolean }>(await api.post('/v0/admin/rotate-admin-token'))
    expect(body.persisted).toBe(false)
  })
})

describe('admin API', () => {
  async function scene() {
    h = await startHttpHub({ version: '0.2.0' })
    const admin = await adminLogin(h)
    const created = await jsonOf<{ room: { room_id: string }; invite_url: string }>(
      await admin.api.post('/v0/admin/rooms', { name: 'ops', description: 'operators' }),
    )
    const roomId = created.room.room_id
    const code = created.invite_url.split('/').at(-1) ?? ''
    const alice = await signIn(h, 'alice')
    await alice.client.request('room.join', {
      session_id: alice.sessionId,
      invite_code: code,
      handle: 'home',
    })
    return { hub: h, admin: admin.api, alice, roomId, code }
  }

  it('lists status, settings, rooms, sessions, members and invites', async () => {
    const { admin, alice, roomId } = await scene()
    const status = await jsonOf<Record<string, unknown>>(await admin.get('/v0/admin/status'))
    expect(status).toMatchObject({
      version: '0.2.0',
      registration: 'invite-only',
      rooms: 1,
      members: 1,
      connections: 1,
    })
    expect(status.public_url).toBe(h?.base)
    const settings = await jsonOf<Record<string, unknown>>(await admin.get('/v0/admin/settings'))
    expect(settings).toMatchObject({ registration: 'invite-only', retention_ms: 30 * 24 * 3600 * 1000 })
    const rooms = await jsonOf<{ rooms: { room: { name: string }; people: number; agents: number }[] }>(
      await admin.get('/v0/admin/rooms'),
    )
    expect(rooms.rooms).toEqual([expect.objectContaining({ people: 1, agents: 1 })])
    const detail = await jsonOf<{ my_role: string; invite: { state: string } }>(
      await admin.get(`/v0/admin/rooms/${roomId}`),
    )
    expect(detail.invite.state).toBe('active')
    const sessions = await jsonOf<{ sessions: { session_id: string }[] }>(
      await admin.get('/v0/admin/sessions'),
    )
    expect(sessions.sessions.map((s) => s.session_id)).toEqual([alice.sessionId])
    const members = await jsonOf<{ members: { name: string; rooms: number; sessions: number }[] }>(
      await admin.get('/v0/admin/members'),
    )
    expect(members.members).toEqual([expect.objectContaining({ name: 'alice', rooms: 1, sessions: 1 })])
    const invites = await jsonOf<{ invites: { room: string; code_masked: string }[] }>(
      await admin.get('/v0/admin/invites'),
    )
    expect(invites.invites).toEqual([expect.objectContaining({ room: 'ops' })])
    expect(invites.invites[0]?.code_masked).toStartWith('inv_')
  })

  it('reads room messages with paging', async () => {
    const { admin, alice, roomId } = await scene()
    for (let i = 0; i < 3; i++) {
      await alice.client.request('msg.send', {
        session_id: alice.sessionId,
        client_msg_id: `01JF00000000000000000000${i}A`,
        room_id: roomId,
        kind: 'chat',
        text: `<b>line ${i}</b>`,
      })
    }
    const page = await jsonOf<{ messages: { text: string; seq: number }[] }>(
      await admin.get(`/v0/admin/rooms/${roomId}/messages?limit=2`),
    )
    expect(page.messages).toHaveLength(2)
    expect(page.messages.map((m) => m.text)).toContain('<b>line 2</b>')
    expect(await errorCode(await admin.get(`/v0/admin/rooms/${roomId}/messages?limit=999`))).toBe(
      'invalid_params',
    )
  })

  it('patches settings: registration and public URL', async () => {
    const { admin, roomId } = await scene()
    const res = await admin.patch('/v0/admin/settings', {
      registration: 'open',
      public_url: 'https://hub.example.com/',
    })
    expect(res.status).toBe(200)
    expect(await jsonOf<Record<string, unknown>>(res)).toMatchObject({
      registration: 'open',
      public_url: 'https://hub.example.com',
    })
    const reg = await caller(h?.base ?? '', undefined, null).post('/v0/members/register', {
      member_name: 'zed',
    })
    expect(reg.status).toBe(201)
    const invite = await jsonOf<{ invite_url: string }>(
      await admin.post(`/v0/admin/rooms/${roomId}/invites`, {}),
    )
    expect(invite.invite_url).toStartWith('https://hub.example.com/j/')
    expect(await errorCode(await admin.patch('/v0/admin/settings', { retention_ms: 1 }))).toBe(
      'invalid_params',
    )
    expect(await errorCode(await admin.patch('/v0/admin/settings', { public_url: 'ftp://x y' }))).toBe(
      'invalid_params',
    )
    expect(await errorCode(await admin.patch('/v0/admin/settings', { registration: 'maybe' }))).toBe(
      'invalid_params',
    )
  })

  it('creates rooms and renders invites with join prompt and command', async () => {
    const { admin, roomId } = await scene()
    const res = await admin.post(`/v0/admin/rooms/${roomId}/invites`, { lang: 'zh', suggested_handle: 'api' })
    expect(res.status).toBe(201)
    const body = await jsonOf<{
      invite_url: string
      join_prompt: string
      join_command: string
      expires_at: null
    }>(res)
    expect(body.join_command).toContain(`sh -s -- join ${body.invite_url} --here --handle 'api'`)
    expect(body.join_prompt).toContain(body.join_command)
    expect(body.expires_at).toBeNull()
    expect(await errorCode(await admin.post('/v0/admin/rooms', { name: 'ops' }))).toBe('invalid_name')
  })

  it('renames a handle, kicks a member and dissolves a room', async () => {
    const { admin, alice, roomId } = await scene()
    const renamed = await admin.patch(`/v0/admin/rooms/${roomId}/handles/home`, { handle: 'desk' })
    expect(await jsonOf<Record<string, unknown>>(renamed)).toEqual({
      room_id: roomId,
      old: 'home',
      new: 'desk',
    })
    expect(await alice.client.waitFor('handle.renamed')).toMatchObject({
      old: 'home',
      new: 'desk',
      by: 'admin',
    })
    expect(
      await errorCode(await admin.patch(`/v0/admin/rooms/${roomId}/handles/ghost`, { handle: 'x' })),
    ).toBe('target_not_found')

    expect((await admin.del(`/v0/admin/rooms/${roomId}/grants/${alice.memberId}`)).status).toBe(200)
    expect(await alice.client.waitFor('kicked')).toMatchObject({ room_id: roomId })
    expect((await admin.del(`/v0/admin/rooms/${roomId}`)).status).toBe(200)
    const rooms = await jsonOf<{ rooms: unknown[] }>(await admin.get('/v0/admin/rooms'))
    expect(rooms.rooms).toEqual([])
  })

  it('revokes invites and member tokens', async () => {
    const { admin, alice } = await scene()
    const invites = await jsonOf<{ invites: { invite_id: string }[] }>(await admin.get('/v0/admin/invites'))
    const id = invites.invites[0]?.invite_id ?? ''
    expect((await admin.del(`/v0/admin/invites/${id}`)).status).toBe(200)
    expect(await errorCode(await admin.del(`/v0/admin/invites/${id}`))).toBe('target_not_found')

    const revoked = await jsonOf<{ revoked: number }>(
      await admin.del(`/v0/admin/members/${alice.memberId}/tokens`),
    )
    expect(revoked.revoked).toBe(1)
    expect(h?.hub.services.members.authenticate(alice.token)).toBeUndefined()
    expect((await alice.api.get('/v0/me')).status).toBe(401)
    expect(await errorCode(await admin.del('/v0/admin/members/01NOPE00000000000000000000/tokens'))).toBe(
      'target_not_found',
    )
  })

  it('streams every hub event to the operator', async () => {
    const { admin, alice, roomId } = await scene()
    const stream = await admin.get('/v0/admin/events')
    expect(stream.status).toBe(200)
    await alice.client.request('msg.send', {
      session_id: alice.sessionId,
      client_msg_id: '01JG0000000000000000000000',
      room_id: roomId,
      kind: 'chat',
      text: 'seen by the operator',
    })
    const events = await readEvents(stream, (es) => es.some((e) => e.event === 'message'))
    expect(events.find((e) => e.event === 'message')?.data).toContain('seen by the operator')
  })

  it('answers unknown admin paths with JSON 404', async () => {
    const { admin } = await scene()
    expect(await errorCode(await admin.get('/v0/admin/nope'))).toBe('method_not_found')
  })

  it('refuses DNS names in the Host header (DNS rebinding)', async () => {
    const { admin } = await scene()
    const rebound = await admin.get('/v0/admin/status', { headers: { host: 'evil.example:7338' } })
    expect(rebound.status).toBe(403)
    const page = await fetch(`${h?.adminBase}/admin/`, { headers: { host: 'evil.example' } })
    expect(page.status).toBe(403)
    expect((await admin.get('/v0/admin/status', { headers: { host: 'localhost:7338' } })).status).toBe(200)
    expect((await admin.get('/v0/admin/status', { headers: { host: '[::1]:7338' } })).status).toBe(200)
  })
})
