/** Immutable local view of one session and the pure reducers that update it. */
import {
  type CardInput,
  type ResultOf,
  type RoomEntry,
  roomIdOf,
  type SessionPatch,
} from '@agent-peers/protocol'

export interface SessionRoom {
  readonly room_id: string
  readonly handle: string
  readonly name?: string
}

export interface KnockView {
  readonly knock_id: string
  readonly room_id: string
  readonly state: string
}

export type SessionStatus = 'new' | 'opening' | 'open' | 'closing' | 'closed'

export interface SessionView {
  readonly localKey: string
  readonly sessionId: string | undefined
  readonly status: SessionStatus
  readonly card: CardInput
  readonly supersedes: string | undefined
  readonly rooms: readonly SessionRoom[]
  /** Rooms the hub reported as `held` by another live session on the last open (PROTOCOL §4). */
  readonly heldRooms: readonly SessionRoom[]
  readonly knocks: readonly KnockView[]
}

export function initialView(localKey: string, card: CardInput, supersedes?: string): SessionView {
  return {
    localKey,
    sessionId: undefined,
    status: 'new',
    card,
    supersedes,
    rooms: [],
    heldRooms: [],
    knocks: [],
  }
}

function toRoom(entry: RoomEntry): SessionRoom | undefined {
  const roomId = roomIdOf(entry)
  if (!roomId) return undefined
  const name = typeof entry.room === 'object' ? entry.room.name : undefined
  return name === undefined
    ? { room_id: roomId, handle: entry.handle }
    : { room_id: roomId, handle: entry.handle, name }
}

export function applyOpenResult(view: SessionView, result: ResultOf<'session.open'>): SessionView {
  const entries = result.rooms.flatMap((entry) => {
    const room = toRoom(entry)
    return room ? [{ room, held: entry.status === 'held' }] : []
  })
  return {
    ...view,
    sessionId: result.session_id,
    status: 'open',
    rooms: entries.filter((e) => !e.held).map((e) => e.room),
    heldRooms: entries.filter((e) => e.held).map((e) => e.room),
  }
}

export function withStatus(view: SessionView, status: SessionStatus): SessionView {
  return view.status === status ? view : { ...view, status }
}

export function addRoom(view: SessionView, room: SessionRoom): SessionView {
  return {
    ...view,
    rooms: [...view.rooms.filter((r) => r.room_id !== room.room_id), room],
    heldRooms: view.heldRooms.filter((r) => r.room_id !== room.room_id),
  }
}

export function removeRoom(view: SessionView, roomId: string): SessionView {
  if (!view.rooms.some((r) => r.room_id === roomId)) return view
  return { ...view, rooms: view.rooms.filter((r) => r.room_id !== roomId) }
}

export function renameHandle(
  view: SessionView,
  roomId: string,
  oldHandle: string,
  newHandle: string,
): SessionView {
  return {
    ...view,
    rooms: view.rooms.map((r) =>
      r.room_id === roomId && r.handle === oldHandle ? { ...r, handle: newHandle } : r,
    ),
  }
}

export function applyRenameResult(view: SessionView, result: ResultOf<'session.rename'>): SessionView {
  const renamed = result.rooms.reduce((acc, r) => renameHandle(acc, r.room_id, r.old, r.new), view)
  return typeof result.title === 'string' ? patchCard(renamed, { title: result.title }) : renamed
}

export function patchCard(view: SessionView, patch: SessionPatch & { readonly title?: string }): SessionView {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  return { ...view, card: { ...view.card, ...defined } }
}

export function upsertKnock(view: SessionView, knock: KnockView): SessionView {
  return { ...view, knocks: [...view.knocks.filter((k) => k.knock_id !== knock.knock_id), knock] }
}

export function removeKnock(view: SessionView, knockId: string): SessionView {
  return { ...view, knocks: view.knocks.filter((k) => k.knock_id !== knockId) }
}
