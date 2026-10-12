/** Rooms (§2, §6.4, §10): create, join, leave, list, search and peers. */
import {
  type MemberEntry,
  type ParsedParamsOf,
  PeersError,
  type Room,
  type RoomEntry,
  type SearchRoom,
} from '@agent-peers/protocol'
import type { RoomRow } from '../storage/repos/rooms'
import type { Access, Actor } from './access'
import type { Cards } from './cards'
import type { Claims } from './claims'
import type { Effects, ServiceDeps } from './context'
import type { Invites, RenderedInvite } from './invites'
import type { Messages } from './messages'
import type { Presence } from './presence'

const SEARCH_LIMIT = 50

export interface CreateRoomInput {
  readonly name: string
  readonly display_name?: string
  readonly description?: string
  readonly discoverable?: boolean
  /** Session callers also join with this handle (default handle when omitted). */
  readonly handle?: string
}

export interface CreatedRoom {
  readonly room: Room
  readonly room_id: string
  readonly handle: string | undefined
  readonly rendered: RenderedInvite | undefined
}

export type JoinParams = ParsedParamsOf<'room.join'>

export interface JoinOutcome {
  readonly room: Room
  readonly handle: string
  readonly members: readonly MemberEntry[]
}

export function createRooms(
  deps: ServiceDeps,
  access: Access,
  cards: Cards,
  claims: Claims,
  invites: Invites,
  messages: Messages,
  presence: Presence,
) {
  const { repos } = deps

  const emitRoom = (fx: Effects, roomId: string, change: 'created' | 'members', room?: Room) =>
    fx.emit({
      name: 'room',
      data: { room_id: roomId, change, ...(room ? { room } : {}) },
      memberIds: access.roomMemberIds(roomId),
      roomId,
    })

  /** Inserts a room with its owner grant and its invite (inside the caller's transaction). */
  const insertRoom = (fx: Effects, input: CreateRoomInput, ownerMemberId: string | null): RoomRow => {
    if (repos.rooms.activeByName(input.name)) {
      throw new PeersError('invalid_name', `a room named ${input.name} already exists`, { reason: 'taken' })
    }
    const id = deps.newId()
    repos.rooms.insert({
      id,
      name: input.name,
      display_name: input.display_name,
      description: input.description,
      discoverable: input.discoverable ?? true,
      owner_member_id: ownerMemberId,
      created_at: deps.now(),
    })
    if (ownerMemberId !== null) repos.grants.upsert(id, ownerMemberId, 'owner', deps.now())
    const room = repos.rooms.byId(id) as RoomRow
    invites.mint(fx, room, ownerMemberId)
    emitRoom(fx, id, 'created', access.wireRoom(room))
    return room
  }

  const members = (roomId: string): readonly MemberEntry[] =>
    repos.handles.forRoom(roomId).flatMap((h) => {
      const card = h.session_id === null ? undefined : cards.byId(h.session_id)
      return card ? [{ room_id: roomId, handle: h.handle, card }] : []
    })

  const create = (actor: Actor, input: CreateRoomInput): CreatedRoom =>
    deps.tx((fx) => {
      if (actor.kind !== 'admin' && !deps.config.allowRoomCreation) {
        throw new PeersError('forbidden', 'room creation is disabled on this hub')
      }
      if (actor.kind !== 'admin' && deps.runtime.publicUrl === undefined) {
        throw new PeersError(
          'forbidden',
          'invites need --public-url when the hub listens on a non-loopback address',
        )
      }
      const room = insertRoom(fx, input, actor.kind === 'admin' ? null : actor.memberId)
      access.audit(actor, 'room.create', room.id, { name: room.name })
      const invite = repos.invites.active(room.id)
      const rendered =
        invite && deps.runtime.publicUrl !== undefined ? invites.render(room, invite) : undefined
      const handle =
        actor.kind === 'session'
          ? claims.claim(fx, {
              sessionId: actor.sessionId,
              roomId: room.id,
              ...(input.handle ? { handle: input.handle } : {}),
            }).handle
          : undefined
      if (actor.kind === 'session') presence.announce(fx, actor.sessionId)
      return { room: access.wireRoom(room), room_id: room.id, handle, rendered }
    })

  const resolveJoinRoom = (fx: Effects, memberId: string, params: JoinParams): RoomRow => {
    if (params.invite_code !== undefined) return invites.redeem(fx, params.invite_code, memberId).room
    if (params.room_id !== undefined) return access.requireRoom(params.room_id)
    const room = repos.rooms.activeByName(params.room_name ?? '')
    if (!room) throw new PeersError('room_not_found', 'room not found')
    return room
  }

  /** `room.join` by room_id, room_name or invite_code, claiming a handle under §2.1. */
  const join = (sessionId: string, params: JoinParams): JoinOutcome =>
    deps.tx((fx) => {
      const session = access.requireSession(sessionId)
      const room = resolveJoinRoom(fx, session.member_id, params)
      const grant = repos.grants.get(room.id, session.member_id)
      if (!grant || grant.revoked_at !== null) {
        const why = grant?.kicked === 1 ? 'you were removed from this room' : 'no active grant for this room'
        throw new PeersError('forbidden', why)
      }
      const claimed = claims.claim(fx, {
        sessionId,
        roomId: room.id,
        ...(params.handle !== undefined ? { handle: params.handle } : {}),
        ...(params.takeover !== undefined ? { takeover: params.takeover } : {}),
      })
      if (claimed.changed) {
        presence.announce(fx, sessionId)
        emitRoom(fx, room.id, 'members')
      }
      return { room: access.wireRoom(room), handle: claimed.handle, members: members(room.id) }
    })

  const leave = (sessionId: string, roomId: string): void =>
    deps.tx((fx) => {
      const handle = access.requireHandle(sessionId, roomId)
      claims.release(fx, roomId, handle.handle, 'left')
      emitRoom(fx, roomId, 'members')
    })

  const list = (sessionId: string): readonly RoomEntry[] =>
    repos.handles.forSession(sessionId).map((h) => {
      const room = repos.rooms.byId(h.room_id) as RoomRow
      return {
        room: access.wireRoom(room),
        room_id: h.room_id,
        handle: h.handle,
        status: 'joined',
        unread: messages.unread(h.room_id, h.handle),
      }
    })

  const myState = (roomId: string, memberId: string): SearchRoom['my_state'] => {
    if (access.activeGrant(roomId, memberId)) return 'member'
    return repos.knocks.pending(roomId, memberId) ? 'knocking' : 'none'
  }

  /** Discoverable rooms only; outsiders see name, owner and member count (§2, §10.2). */
  const search = (memberId: string, q: string): readonly SearchRoom[] =>
    repos.rooms.search(q.trim(), SEARCH_LIMIT).map((row) => ({
      room_id: row.id,
      name: row.name,
      ...(row.display_name !== null ? { display_name: row.display_name } : {}),
      owner: row.owner_name ?? 'admin',
      member_count: repos.grants.countActive(row.id),
      my_state: myState(row.id, memberId),
    }))

  const peers = (sessionId: string, roomId?: string): readonly MemberEntry[] => {
    if (roomId !== undefined) {
      access.requireHandle(sessionId, roomId)
      return members(roomId)
    }
    return repos.handles.forSession(sessionId).flatMap((h) => members(h.room_id))
  }

  return { create, insertRoom, join, leave, list, search, peers, members }
}
export type Rooms = ReturnType<typeof createRooms>
