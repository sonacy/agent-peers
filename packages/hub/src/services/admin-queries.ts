/**
 * Read models for the operator view (DASHBOARD §10) and the few lookups the HTTP layer needs that
 * the other services don't expose: rooms, sessions, members and invites across the hub.
 */
import { maskInviteCode, PeersError, type Room, type SessionCard } from '@agent-peers/protocol'
import type { Services } from './index'

export interface AdminRoom {
  readonly room: Room
  readonly people: number
  readonly agents: number
  readonly open_asks: number
  readonly pending_knocks: number
  readonly last_activity_at: number | null
}

export interface AdminMember {
  readonly member_id: string
  readonly name: string
  readonly created_at: number
  readonly rooms: number
  readonly sessions: number
}

export interface AdminInvite {
  readonly invite_id: string
  readonly room_id: string
  readonly room: string
  readonly code_masked: string
  readonly role: string
  readonly created_at: number
}

export interface HubCounts {
  readonly rooms: number
  readonly members: number
  readonly sessions_online: number
}

export function createAdminQueries(services: Services) {
  const { repos } = services.deps

  const rooms = (): readonly AdminRoom[] =>
    repos.rooms.listActive().map((row) => ({
      room: services.access.wireRoom(row),
      people: repos.grants.countActive(row.id),
      agents: services.queries.agentsIn(row.id).length,
      open_asks: repos.asks.openInRoom(row.id).length,
      pending_knocks: repos.knocks.pendingForRoom(row.id).length,
      last_activity_at: repos.messages.lastTs(row.id) ?? null,
    }))

  const sessions = (): readonly SessionCard[] => repos.sessions.list().map(services.cards.build)

  const members = (): readonly AdminMember[] =>
    repos.members.list().map((m) => ({
      member_id: m.id,
      name: m.name,
      created_at: m.created_at,
      rooms: repos.grants.activeForMember(m.id).length,
      sessions: repos.sessions.forMember(m.id).filter((s) => s.closed_at === null).length,
    }))

  const invites = (): readonly AdminInvite[] =>
    repos.invites.listActive().map((row) => ({
      invite_id: row.id,
      room_id: row.room_id,
      room: repos.rooms.byId(row.room_id)?.name ?? '',
      code_masked: maskInviteCode(row.last4),
      role: row.role,
      created_at: row.created_at,
    }))

  const counts = (): HubCounts => ({
    rooms: repos.rooms.listActive().length,
    members: repos.members.list().length,
    sessions_online: repos.sessions.notOffline().length,
  })

  /** The room an active invite belongs to; `target_not_found` when unknown or already closed. */
  const activeInviteRoom = (inviteId: string): string => {
    const invite = repos.invites.byId(inviteId)
    if (!invite || invite.closed_at !== null)
      throw new PeersError('target_not_found', 'no such active invite')
    return invite.room_id
  }

  const requireMember = (memberId: string): void => {
    if (!repos.members.byId(memberId)) throw new PeersError('target_not_found', 'no such member')
  }

  /** A member path parameter may be an id or a name; services take names. */
  const memberName = (ref: string): string => repos.members.byId(ref)?.name ?? ref

  /** The member's dashboard sessions: open ones, plus closed ones that still hold a handle. */
  const memberSessions = (memberId: string): readonly SessionCard[] =>
    services.cards
      .forMember(memberId)
      .filter((card) => card.connection !== 'offline' || card.rooms.length > 0)

  return {
    rooms,
    sessions,
    members,
    invites,
    counts,
    activeInviteRoom,
    requireMember,
    memberName,
    memberSessions,
  }
}
export type AdminQueries = ReturnType<typeof createAdminQueries>
