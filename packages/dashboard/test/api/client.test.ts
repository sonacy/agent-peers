import { describe, expect, it } from 'bun:test'
import { createApiClient } from '../../src/api/client'
import {
  ApiError,
  codeForStatus,
  friendlyError,
  isNotFound,
  isUnauthorized,
  toErrorCode,
} from '../../src/api/errors'
import { apiError, createFakeHub, json } from '../helpers/fake-hub'
import { card, ME, myRoom, thread } from '../helpers/fixtures'

const OK = { ok: true }

function setup() {
  const hub = createFakeHub({
    'GET /v0/me': ME,
    'GET /v0/me/sessions': { sessions: [card()] },
    'GET /v0/me/rooms': { rooms: [myRoom()] },
    'GET /v0/me/rooms/r_1': { room: { room_id: 'r_1', name: 'timely' }, my_role: 'owner', people: [] },
    'GET /v0/rooms/search': {
      rooms: [{ room_id: 'r_2', name: 'api', owner: 'li', member_count: 3, my_state: 'none' }],
    },
    'GET /v0/me/asks': { asks: [thread()], next_cursor: 'c2' },
    'POST /app/login': { ok: true, member: ME },
    'POST /v0/me/logout': OK,
    'PATCH /v0/me/sessions/s_1': { session: card({ accepting: false }) },
    'POST /v0/me/rooms': () =>
      json(
        {
          room: { room_id: 'r_new', name: 'new' },
          invite: {
            room_id: 'r_new',
            state: 'active',
            code_masked: 'inv_••••1234',
            role: 'member',
            created_at: 1,
          },
          invite_url: 'http://hub/j/x',
          join_prompt: '[peers invite] …',
        },
        201,
      ),
    'POST /v0/me/rooms/r_1/knock': () => json({ knock: knock() }, 201),
    'DELETE /v0/me/knocks/k_1': OK,
    'POST /v0/me/knocks/k_1/decide': { knock: { ...knock(), state: 'accepted' } },
    'POST /v0/me/rooms/r_1/invite/close': { invite: null, invite_url: null, join_prompt: null },
    'POST /v0/me/rooms/r_1/restore/m_li': OK,
    'POST /v0/me/rooms/r_1/exit': OK,
    'DELETE /v0/me/rooms/r_1/sessions/s_1': OK,
    'DELETE /v0/me/rooms/r_1/grants/m_li': OK,
    'DELETE /v0/me/rooms/r_1': OK,
  })
  return { hub, api: createApiClient({ fetch: hub.fetch }) }
}

function knock() {
  return { knock_id: 'k_1', room_id: 'r_1', member: 'li', state: 'pending', created_at: 1, expires_at: 2 }
}

describe('createApiClient', () => {
  it('reads every member endpoint with the cookie and validates responses', async () => {
    const { hub, api } = setup()
    expect(await api.me()).toEqual(ME)
    expect((await api.sessions())[0]?.session_id).toBe('s_1')
    expect((await api.rooms())[0]?.room.name).toBe('timely')
    expect((await api.room('r_1')).my_role).toBe('owner')
    expect((await api.searchRooms('a p'))[0]?.name).toBe('api')
    expect((await api.asks('mine', 'c 1')).next_cursor).toBe('c2')
    await api.asks('all')
    expect(hub.calls.every((c) => c.credentials === 'include')).toBe(true)
    expect(hub.calls.map((c) => c.path)).toContain('/v0/rooms/search?q=a%20p')
    expect(hub.calls.map((c) => c.path)).toContain('/v0/me/asks?filter=mine&cursor=c%201')
    expect(hub.calls.map((c) => c.path)).toContain('/v0/me/asks?filter=all')
  })
  it('sends every mutation with the right method, path and body', async () => {
    const { hub, api } = setup()
    await api.login('code-1')
    await api.logout()
    expect((await api.patchSession('s_1', { accepting: false })).accepting).toBe(false)
    expect((await api.createRoom({ name: 'new', discoverable: true })).room.room_id).toBe('r_new')
    expect((await api.knock('r_1', '想问问')).knock.knock_id).toBe('k_1')
    await api.knock('r_1')
    await api.withdrawKnock('k_1')
    expect((await api.decideKnock('k_1', 'accept')).knock.state).toBe('accepted')
    expect((await api.inviteAction('r_1', 'close')).invite).toBeNull()
    await api.restoreMember('r_1', 'm_li')
    await api.exitRoom('r_1')
    await api.removeSession('r_1', 's_1')
    await api.kickMember('r_1', 'm_li')
    await api.dissolveRoom('r_1')
    const bodies = hub.calls.map((c) => [c.method, c.path, c.body])
    expect(bodies).toContainEqual(['POST', '/app/login', { code: 'code-1' }])
    expect(bodies).toContainEqual(['PATCH', '/v0/me/sessions/s_1', { accepting: false }])
    expect(bodies).toContainEqual(['POST', '/v0/me/rooms/r_1/knock', { note: '想问问' }])
    expect(bodies).toContainEqual(['POST', '/v0/me/rooms/r_1/knock', {}])
    expect(bodies).toContainEqual(['POST', '/v0/me/knocks/k_1/decide', { decision: 'accept' }])
    expect(bodies).toContainEqual(['DELETE', '/v0/me/rooms/r_1', undefined])
  })
  it('maps error bodies, bare statuses, bad JSON and network failures to ApiError', async () => {
    const hub = createFakeHub({
      'GET /v0/me': () => apiError('unauthorized', 401, 'sign in'),
      'GET /v0/me/sessions': () =>
        new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }),
      'GET /v0/me/rooms': () => apiError('rate_limited', 429, 'slow down', 4200),
      'GET /v0/me/asks': { unexpected: true },
      'GET /v0/me/rooms/r_x': () => new Response('', { status: 404 }),
    })
    const api = createApiClient({ fetch: hub.fetch, baseUrl: '' })
    const me = await api.me().catch((e: unknown) => e)
    expect(me).toBeInstanceOf(ApiError)
    expect(isUnauthorized(me)).toBe(true)
    expect(((await api.sessions().catch((e: unknown) => e)) as ApiError).code).toBe('internal')
    const limited = (await api.rooms().catch((e: unknown) => e)) as ApiError
    expect(limited.retryAfterMs).toBe(4200)
    expect(friendlyError(limited)).toBe('操作太快了，5 秒后再试。')
    expect(((await api.asks('all').catch((e: unknown) => e)) as ApiError).code).toBe('invalid_result')
    expect(isNotFound(await api.room('r_x').catch((e: unknown) => e))).toBe(true)
    const offline = createApiClient({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    })
    const down = (await offline.me().catch((e: unknown) => e)) as ApiError
    expect(down.code).toBe('disconnected')
    expect(down.status).toBe(0)
    const weird = createApiClient({ fetch: () => Promise.reject('nope') })
    expect(((await weird.me().catch((e: unknown) => e)) as ApiError).message).toBe('network error')
  })
})

describe('errors', () => {
  it('derives codes from statuses and unknown body codes', () => {
    expect([401, 403, 404, 413, 429, 400, 422, 500].map(codeForStatus)).toEqual([
      'unauthorized',
      'forbidden',
      'room_not_found',
      'payload_too_large',
      'rate_limited',
      'invalid_params',
      'invalid_params',
      'internal',
    ])
    expect(toErrorCode('handle_taken', 409)).toBe('handle_taken')
    expect(toErrorCode('brand_new_code', 403)).toBe('forbidden')
  })
  it('gives friendly copy that says why and what next', () => {
    expect(friendlyError(new ApiError('handle_taken', 'x', 409))).toContain('换一个')
    expect(friendlyError(new ApiError('unauthorized', 'x', 401))).toContain('/peers:dashboard')
    expect(friendlyError(new ApiError('rate_limited', 'x', 429))).toBe('操作太快了，5 秒后再试。')
    expect(friendlyError(new ApiError('ask_taken', 'x', 409))).toBe('Core 出了点问题，稍后再试。')
    expect(friendlyError(new Error('boom'))).toBe('Core 出了点问题，稍后再试。')
    expect(isNotFound(new Error('x'))).toBe(false)
  })
})
