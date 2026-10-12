/** Removing agents and people (§10.3): remove_session, exit, kick, restore and dissolve. */
import { PeersError, type RoomRemovedReason } from '@agent-peers/protocol'
import type { Access, Actor } from './access'
import type { Asks } from './asks'
import type { Claims } from './claims'
import type { Effects, ServiceDeps } from './context'
import type { Invites } from './invites'

export interface KickedMember {
  readonly member_id: string
  readonly member: string
  readonly kicked_at: number
}

export function createMembership(
  deps: ServiceDeps,
  access: Access,
  claims: Claims,
  asks: Asks,
  invites: Invites,
) {
  const { repos } = deps

  const removed = (fx: Effects, sessionIds: readonly string[], roomId: string, reason: RoomRemovedReason) => {
    for (const id of new Set(sessionIds)) fx.notify(id, 'room.removed', { room_id: roomId, reason })
  }

  const emitMembers = (fx: Effects, roomId: string, extra: readonly string[] = []) =>
    fx.emit({
      name: 'room',
      data: { room_id: roomId, change: 'members' },
      memberIds: [...new Set([...access.roomMemberIds(roomId), ...extra])],
      roomId,
    })

  /** Allowed for the target's own member or the room owner; the grant stays. */
  const removeSession = (actor: Actor, roomId: string, targetSessionId: string): void =>
    deps.tx((fx) => {
      access.requireRoom(roomId)
      const target = repos.sessions.byId(targetSessionId)
      if (!target) throw new PeersError('target_not_found', 'unknown session')
      const own = actor.kind !== 'admin' && actor.memberId === target.member_id
      if (!own && !access.isOwner(actor, roomId))
        throw new PeersError('forbidden', 'not allowed to remove this session')
      const handle = repos.handles.bySession(targetSessionId, roomId)
      if (!handle) throw new PeersError('target_not_found', 'that session is not in the room')
      claims.release(fx, roomId, handle.handle, 'removed')
      repos.sessionRooms.delete(targetSessionId, roomId)
      removed(fx, [targetSessionId], roomId, 'removed')
      emitMembers(fx, roomId)
    })

  /** The member leaves: revokes their own grant and removes all their sessions. Owners dissolve instead. */
  const exit = (actor: Actor, roomId: string): void =>
    deps.tx((fx) => {
      if (actor.kind === 'admin') throw new PeersError('forbidden', 'the operator holds no grant')
      access.requireRoom(roomId)
      const grant = access.requireGrant(roomId, actor.memberId)
      if (grant.role === 'owner') throw new PeersError('forbidden', 'an owner must dissolve the room instead')
      const sessions = claims.releaseMember(fx, roomId, actor.memberId, 'exited')
      repos.grants.revoke(roomId, actor.memberId, deps.now(), false)
      removed(fx, sessions, roomId, 'removed')
      emitMembers(fx, roomId, [actor.memberId])
    })

  /**
   * Revokes the grant and removes the member's sessions. The kicked member knows the current invite
   * code, so an active invite is rotated: a fresh member identity can't walk straight back in (§8).
   */
  const kick = (actor: Actor, roomId: string, memberName: string): void =>
    deps.tx((fx) => {
      const room = access.requireOwner(actor, roomId)
      const member = repos.members.byName(memberName)
      const grant = member ? access.activeGrant(roomId, member.id) : undefined
      if (!member || !grant) throw new PeersError('target_not_found', `${memberName} is not in this room`)
      if (grant.role === 'owner') throw new PeersError('forbidden', 'the owner cannot be kicked')
      const sessions = claims.releaseMember(fx, roomId, member.id, 'kicked')
      repos.grants.revoke(roomId, member.id, deps.now(), true)
      if (repos.invites.active(roomId)) invites.mint(fx, room, actor.kind === 'admin' ? null : actor.memberId)
      removed(fx, sessions, roomId, 'kicked')
      // Every open session of the member learns of the kick, so bridges drop the room from auto-join.
      for (const session of repos.sessions.forMember(member.id)) {
        if (session.closed_at === null)
          fx.notify(session.id, 'kicked', { room_id: roomId, reason: 'removed by the room owner' })
      }
      access.audit(actor, 'room.kick', roomId, { member: memberName })
      emitMembers(fx, roomId, [member.id])
    })

  const kicked = (actor: Actor, roomId: string): readonly KickedMember[] => {
    access.requireOwner(actor, roomId)
    return repos.grants
      .kickedForRoom(roomId)
      .filter((g) => g.revoked_at !== null)
      .map((g) => ({
        member_id: g.member_id,
        member: g.member_name,
        kicked_at: g.kicked_at ?? g.revoked_at ?? 0,
      }))
  }

  /** Re-grants `member` to a kicked member. */
  const restore = (actor: Actor, roomId: string, memberName: string): void =>
    deps.tx((fx) => {
      access.requireOwner(actor, roomId)
      const member = repos.members.byName(memberName)
      const grant = member ? repos.grants.get(roomId, member.id) : undefined
      if (!member || grant?.kicked !== 1)
        throw new PeersError('target_not_found', `${memberName} was not kicked`)
      repos.grants.upsert(roomId, member.id, 'member', deps.now())
      access.audit(actor, 'room.restore', roomId, { member: memberName })
      emitMembers(fx, roomId)
    })

  /** Removes everyone, closes the invite and drops pending knocks; messages are kept (§10.3). */
  const dissolve = (actor: Actor, roomId: string): void =>
    deps.tx((fx) => {
      const room = access.requireOwner(actor, roomId)
      const audience = access.roomMemberIds(roomId)
      const sessions = repos.handles.forRoom(roomId).flatMap((h) => {
        const released = claims.release(fx, roomId, h.handle, 'dissolved')
        return released?.session_id ? [released.session_id] : []
      })
      asks.failRoom(fx, roomId)
      const invite = repos.invites.active(roomId)
      if (invite) repos.invites.close(invite.id, deps.now(), 'dissolved')
      repos.knocks.deletePendingForRoom(roomId)
      repos.grants.revokeAllInRoom(roomId, deps.now())
      repos.sessionRooms.deleteRoom(roomId)
      repos.rooms.dissolve(roomId, deps.now())
      removed(fx, sessions, roomId, 'dissolved')
      access.audit(actor, 'room.dissolve', roomId, { name: room.name })
      fx.emit({ name: 'room', data: { room_id: roomId, change: 'dissolved' }, memberIds: audience, roomId })
    })

  return { removeSession, exit, kick, kicked, restore, dissolve }
}
export type Membership = ReturnType<typeof createMembership>
