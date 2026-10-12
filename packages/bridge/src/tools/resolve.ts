/** Resolving rooms and ask targets from tool arguments (ARCHITECTURE §3.1). */
import type { SessionRoom } from '@agent-peers/core'
import { isValidName, PeersError } from '@agent-peers/protocol'
import type { BridgeSession } from '../session/bridge-session'

const label = (room: SessionRoom): string => room.name ?? room.room_id

/** A room by name or id among the session's rooms; without an argument, the only room. */
export function resolveRoom(session: BridgeSession, room: string | undefined): SessionRoom {
  const rooms = session.rooms
  if (room !== undefined) {
    const wanted = room.trim().replace(/^#/, '')
    const found = rooms.find((r) => r.name === wanted || r.room_id === wanted)
    if (found) return found
    throw new PeersError('room_not_found', `this session is not in a room "${wanted}"`)
  }
  const only = rooms[0]
  if (rooms.length === 1 && only) return only
  if (rooms.length === 0)
    throw new PeersError('room_not_found', 'this session has not joined any room yet (peers_join)')
  throw new PeersError('invalid_params', `several rooms joined (${rooms.map(label).join(', ')}): name one`)
}

export interface AskTarget {
  readonly handle: string
  readonly room?: string
}

/** `@handle`, `handle` or `@handle@room`. */
export function parseTarget(target: string): AskTarget {
  const [handle = '', room, ...rest] = target.trim().replace(/^@/, '').split('@')
  if (!isValidName(handle) || rest.length > 0 || (room !== undefined && !isValidName(room)))
    throw new PeersError('invalid_name', `"${target}" is not @handle or @handle@room`)
  return room === undefined ? { handle } : { handle, room }
}

/**
 * The room to ask `@handle` in: the named room, else the only joined room holding that handle.
 * A handle present in several rooms needs `@handle@room`.
 */
export async function resolveAskRoom(session: BridgeSession, target: AskTarget): Promise<SessionRoom> {
  if (target.room !== undefined) return resolveRoom(session, target.room)
  const rooms = session.rooms
  if (rooms.length === 0) throw new PeersError('room_not_found', 'join a room first (peers_join)')
  const { members } = await session.handle.peers()
  session.roster.setAll(members)
  const holding = rooms.filter((room) =>
    members.some((m) => m.room_id === room.room_id && m.handle === target.handle),
  )
  const only = holding[0]
  if (holding.length === 1 && only) return only
  if (holding.length > 1) {
    const options = holding.map((room) => `@${target.handle}@${label(room)}`).join(' or ')
    throw new PeersError('invalid_params', `@${target.handle} is in several rooms: use ${options}`)
  }
  throw new PeersError('target_not_found', `no @${target.handle} in ${rooms.map(label).join(', ')}`)
}
