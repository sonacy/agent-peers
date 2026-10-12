/** Lookups and authorization shared by the services (§2, §8 roles). */
import { type NotificationName, PeersError, type Room } from '@agent-peers/protocol'
import type { GrantRow } from '../storage/repos/grants'
import type { HandleRow } from '../storage/repos/handles'
import type { RoomRow } from '../storage/repos/rooms'
import type { SessionRow } from '../storage/repos/sessions'
import type { Effects, NotifyParams, ServiceDeps } from './context'
import { toWireRoom } from './wire'

/** Who is calling: a bridge session, a signed-in dashboard member, or the hub operator. */
export type Actor =
  | { readonly kind: 'session'; readonly memberId: string; readonly sessionId: string }
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'admin' }

export const ADMIN: Actor = Object.freeze({ kind: 'admin' })

export function actorLabel(actor: Actor): string {
  if (actor.kind === 'admin') return 'admin'
  return actor.kind === 'session' ? `session:${actor.sessionId}` : `member:${actor.memberId}`
}

export function memberIdOf(actor: Actor): string | undefined {
  return actor.kind === 'admin' ? undefined : actor.memberId
}

export function createAccess(deps: ServiceDeps) {
  const { repos } = deps

  const requireRoom = (roomId: string): RoomRow => {
    const room = repos.rooms.byId(roomId)
    if (!room || room.dissolved_at !== null) throw new PeersError('room_not_found', 'room not found')
    return room
  }

  const ownerName = (room: RoomRow): string | undefined =>
    room.owner_member_id === null ? undefined : repos.members.byId(room.owner_member_id)?.name

  const activeGrant = (roomId: string, memberId: string): GrantRow | undefined => {
    const grant = repos.grants.get(roomId, memberId)
    return grant && grant.revoked_at === null ? grant : undefined
  }

  const requireGrant = (roomId: string, memberId: string): GrantRow => {
    const grant = activeGrant(roomId, memberId)
    if (!grant) throw new PeersError('forbidden', 'no active grant for this room')
    return grant
  }

  const isOwner = (actor: Actor, roomId: string): boolean => {
    if (actor.kind === 'admin') return true
    return activeGrant(roomId, actor.memberId)?.role === 'owner'
  }

  const requireOwner = (actor: Actor, roomId: string): RoomRow => {
    const room = requireRoom(roomId)
    if (!isOwner(actor, roomId)) throw new PeersError('forbidden', 'only the room owner may do this')
    return room
  }

  const requireSession = (sessionId: string): SessionRow => {
    const session = repos.sessions.byId(sessionId)
    if (!session) throw new PeersError('unknown_session', 'unknown session')
    return session
  }

  const requireHandle = (sessionId: string, roomId: string): HandleRow => {
    requireRoom(roomId)
    const handle = repos.handles.bySession(sessionId, roomId)
    if (!handle) throw new PeersError('forbidden', 'this session has not joined the room')
    return handle
  }

  /** Sessions currently holding a handle in the room and not offline. */
  const liveHolders = (roomId: string): readonly { readonly sessionId: string; readonly handle: string }[] =>
    repos.handles.forRoom(roomId).flatMap((h) => {
      if (h.session_id === null) return []
      const session = repos.sessions.byId(h.session_id)
      return session && session.connection !== 'offline' && session.closed_at === null
        ? [{ sessionId: h.session_id, handle: h.handle }]
        : []
    })

  const isLive = (sessionId: string | null): boolean => {
    if (sessionId === null) return false
    const session = repos.sessions.byId(sessionId)
    return session !== undefined && session.closed_at === null && session.connection !== 'offline'
  }

  const notifyRoom = <N extends NotificationName>(
    fx: Effects,
    roomId: string,
    name: N,
    params: NotifyParams<N>,
    exceptSessionId?: string,
  ) => {
    for (const holder of liveHolders(roomId)) {
      if (holder.sessionId !== exceptSessionId) fx.notify(holder.sessionId, name, params)
    }
  }

  const roomMemberIds = (roomId: string): readonly string[] =>
    repos.grants.activeForRoom(roomId).map((g) => g.member_id)

  const wireRoom = (room: RoomRow): Room => toWireRoom(room, ownerName(room))

  const audit = (actor: Actor, action: string, roomId?: string, detail?: Readonly<Record<string, unknown>>) =>
    repos.audit.insert({
      ts: deps.now(),
      actor: actorLabel(actor),
      action,
      ...(roomId !== undefined ? { roomId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })

  return {
    requireRoom,
    ownerName,
    activeGrant,
    requireGrant,
    isOwner,
    requireOwner,
    requireSession,
    requireHandle,
    liveHolders,
    isLive,
    notifyRoom,
    roomMemberIds,
    wireRoom,
    audit,
  }
}
export type Access = ReturnType<typeof createAccess>
