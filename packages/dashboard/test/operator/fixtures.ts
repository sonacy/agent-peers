/** Operator-view fixtures: admin-listener responses (no React, safe for non-DOM tests). */
import type { AdminMember, AdminRoom, HubSettings, HubStatus } from '../../src/routes/operator/admin-schemas'
import { createFakeHub, type FakeHub, type Handler } from '../helpers/fake-hub'

export const NOW = Date.now()

export const STATUS: HubStatus = {
  version: '0.1.0',
  public_url: 'https://peers.example.com',
  registration: 'invite-only',
  started_at: NOW - 3 * 3_600_000,
  uptime_ms: 3 * 3_600_000 + 12 * 60_000,
  connections: 17,
  sessions_attached: 17,
  rooms: 4,
  members: 22,
  sessions_online: 17,
}

export const SETTINGS: HubSettings = {
  public_url: 'https://peers.example.com',
  registration: 'invite-only',
  allow_room_creation: true,
  retention_ms: 30 * 86_400_000,
  messages_per_minute: 30,
  rate_limits: { redeem: 10, preview: 30, register: 5, login: 20 },
  heartbeat_ms: 15_000,
  grace_ms: 60_000,
  public_bind: '0.0.0.0',
  admin_bind: '127.0.0.1',
  version: '0.1.0',
}

export function adminRoom(id: string, name: string, overrides: Partial<AdminRoom> = {}): AdminRoom {
  return {
    room: { room_id: id, name, owner: 'gulei', created_at: NOW - 86_400_000 },
    people: 3,
    agents: 5,
    open_asks: 1,
    pending_knocks: 0,
    last_activity_at: NOW - 120_000,
    ...overrides,
  }
}

export function adminMember(id: string, name: string, overrides: Partial<AdminMember> = {}): AdminMember {
  return { member_id: id, name, created_at: NOW - 86_400_000, rooms: 2, sessions: 1, ...overrides }
}

export const ROOMS: readonly AdminRoom[] = [
  adminRoom('r_timely', 'timely', { pending_knocks: 2 }),
  adminRoom('r_pay', 'pay-integration', {
    room: { room_id: 'r_pay', name: 'pay-integration', display_name: '支付联调', owner: 'zhang-wei' },
    last_activity_at: null,
  }),
]

export const MEMBERS: readonly AdminMember[] = [
  adminMember('m_gulei', 'gulei', { rooms: 4, sessions: 3 }),
  adminMember('m_zhang', 'zhang-wei'),
]

/** A signed-in admin listener with the fixtures above. Override any route. */
export function adminHub(routes: Record<string, Handler> = {}): FakeHub {
  return createFakeHub({
    'GET /v0/admin/whoami': { admin: true },
    'GET /v0/admin/status': STATUS,
    'GET /v0/admin/settings': SETTINGS,
    'GET /v0/admin/rooms': { rooms: ROOMS },
    'GET /v0/admin/members': { members: MEMBERS },
    ...routes,
  })
}
