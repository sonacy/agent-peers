import { describe, expect, it } from 'bun:test'
import { ApiError } from '../../src/api/errors'
import { createAdminClient } from '../../src/routes/operator/admin-api'
import { apiError, createFakeHub, json } from '../helpers/fake-hub'
import { MEMBERS, ROOMS, SETTINGS, STATUS } from './fixtures'

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('admin client', () => {
  it('reads and validates every admin view', async () => {
    const hub = createFakeHub({
      'GET /v0/admin/whoami': { admin: true },
      'GET /v0/admin/status': STATUS,
      'GET /v0/admin/settings': SETTINGS,
      'GET /v0/admin/rooms': { rooms: ROOMS },
      'GET /v0/admin/members': { members: MEMBERS },
    })
    const api = createAdminClient({ fetch: hub.fetch })
    expect(await api.whoami()).toBe(true)
    expect((await api.status()).uptime_ms).toBe(STATUS.uptime_ms)
    expect((await api.settings()).rate_limits.login).toBe(20)
    expect((await api.rooms()).map((r) => r.room.name)).toEqual(['timely', 'pay-integration'])
    expect((await api.members()).map((m) => m.name)).toEqual(['gulei', 'zhang-wei'])
    expect(hub.calls.every((c) => c.credentials === 'include')).toBe(true)
  })
  it('sends writes with JSON bodies to the right paths', async () => {
    const hub = createFakeHub({
      'POST /v0/admin/login': { ok: true },
      'POST /v0/admin/logout': { ok: true },
      'PATCH /v0/admin/settings': SETTINGS,
      'DELETE /v0/admin/rooms/r 1': { ok: true },
      'DELETE /v0/admin/members/m_1/tokens': { revoked: 3 },
      'POST /v0/admin/rotate-admin-token': { admin_token: 'apa_x', persisted: true },
    })
    const api = createAdminClient({ fetch: (input, init) => hub.fetch(decodeURIComponent(input), init) })
    await api.login('apa_token')
    await api.logout()
    await api.patchSettings({ registration: 'open' })
    await api.dissolveRoom('r 1')
    expect(await api.revokeTokens('m_1')).toBe(3)
    expect(await api.rotateToken()).toEqual({ admin_token: 'apa_x', persisted: true })
    expect(hub.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/v0/admin/login', { token: 'apa_token' }],
      ['POST', '/v0/admin/logout', undefined],
      ['PATCH', '/v0/admin/settings', { registration: 'open' }],
      ['DELETE', '/v0/admin/rooms/r 1', undefined],
      ['DELETE', '/v0/admin/members/m_1/tokens', undefined],
      ['POST', '/v0/admin/rotate-admin-token', undefined],
    ])
  })
  it('turns hub errors, bad bodies and network failures into ApiError', async () => {
    const hub = createFakeHub({
      'GET /v0/admin/whoami': () => apiError('unauthorized', 401),
      'GET /v0/admin/status': { version: 1 },
      'GET /v0/admin/settings': () =>
        new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }),
      'GET /v0/admin/rooms': () => new Response('', { status: 200 }),
      'GET /v0/admin/members': () => json({ error: { code: 'nope', message: 'x' } }, 403),
    })
    const api = createAdminClient({ fetch: hub.fetch, baseUrl: '' })
    expect((await failureOf(api.whoami())).code).toBe('unauthorized')
    expect((await failureOf(api.status())).code).toBe('invalid_result')
    const gateway = await failureOf(api.settings())
    expect([gateway.code, gateway.status, gateway.message]).toEqual(['internal', 502, 'Bad Gateway'])
    expect((await failureOf(api.rooms())).code).toBe('invalid_result')
    expect((await failureOf(api.members())).code).toBe('forbidden')
    const offline = createAdminClient({
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const down = await failureOf(offline.status())
    expect([down.code, down.status, down.message]).toEqual(['disconnected', 0, 'fetch failed'])
  })
  it('prefixes a base URL', async () => {
    const seen: string[] = []
    const api = createAdminClient({
      baseUrl: 'http://127.0.0.1:7338',
      fetch: async (input) => {
        seen.push(input)
        return json({ admin: true })
      },
    })
    await api.whoami()
    expect(seen).toEqual(['http://127.0.0.1:7338/v0/admin/whoami'])
  })
})
