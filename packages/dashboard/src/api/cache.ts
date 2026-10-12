/**
 * Pure cache updaters: each returns a new value and never mutates its input. Used by optimistic
 * mutations and by the live-event patcher (DASHBOARD §11).
 */

import type { AskRecord } from '@agent-peers/protocol'
import type { InfiniteData } from '@tanstack/react-query'
import type { AsksPage, RoomDetail, SessionCard, SessionPatch } from './types'

type Sessions = readonly SessionCard[]

/** Replaces the card with the same id; undefined when it isn't in the list (caller refetches). */
export function replaceSession(list: Sessions | undefined, card: SessionCard): Sessions | undefined {
  if (list === undefined || !list.some((s) => s.session_id === card.session_id)) return undefined
  return list.map((s) => (s.session_id === card.session_id ? card : s))
}

/** Applies a PATCH body locally: accepting, title, and a handle rename in one room. */
export function patchCard(card: SessionCard, patch: SessionPatch): SessionCard {
  const rooms =
    patch.handle === undefined || patch.room_id === undefined
      ? card.rooms
      : card.rooms.map((r) => (r.room_id === patch.room_id ? { ...r, handle: patch.handle ?? r.handle } : r))
  return {
    ...card,
    ...(patch.accepting === undefined ? {} : { accepting: patch.accepting }),
    ...(patch.title === undefined ? {} : { title: patch.title }),
    rooms,
  }
}

/** Undoes a PATCH on one card: the fields it set go back to their earlier values, the rest stay. */
export function restoreSessionFields(
  current: SessionCard,
  before: SessionCard,
  patch: SessionPatch,
): SessionCard {
  const oldHandle = before.rooms.find((r) => r.room_id === patch.room_id)?.handle
  const rooms =
    patch.handle === undefined || oldHandle === undefined
      ? current.rooms
      : current.rooms.map((r) => (r.room_id === patch.room_id ? { ...r, handle: oldHandle } : r))
  const { title: _dropped, ...rest } = current
  const title = patch.title === undefined ? current.title : before.title
  return {
    ...rest,
    ...(title === undefined ? {} : { title }),
    ...(patch.accepting === undefined ? {} : { accepting: before.accepting }),
    rooms,
  }
}

export function patchSessionInList(
  list: Sessions | undefined,
  sessionId: string,
  patch: SessionPatch,
): Sessions | undefined {
  return list?.map((s) => (s.session_id === sessionId ? patchCard(s, patch) : s))
}

export function removeRoomFromSession(
  list: Sessions | undefined,
  sessionId: string,
  roomId: string,
): Sessions | undefined {
  return list?.map((s) =>
    s.session_id === sessionId ? { ...s, rooms: s.rooms.filter((r) => r.room_id !== roomId) } : s,
  )
}

/** Replaces a session card wherever it appears in a room detail; undefined when it isn't there. */
export function replaceCardInRoom(detail: RoomDetail | undefined, card: SessionCard): RoomDetail | undefined {
  if (detail === undefined) return undefined
  let found = false
  const people = detail.people.map((person) => ({
    ...person,
    agents: person.agents.map((agent) => {
      if (agent.card.session_id !== card.session_id) return agent
      found = true
      return { ...agent, card }
    }),
  }))
  return found ? { ...detail, people } : undefined
}

export type AsksData = InfiniteData<AsksPage>

/** Updates the ask record of a thread in every loaded page; undefined when no page holds it. */
export function patchAskInPages(data: AsksData | undefined, ask: AskRecord): AsksData | undefined {
  if (data === undefined) return undefined
  let found = false
  const pages = data.pages.map((page) => ({
    ...page,
    asks: page.asks.map((thread) => {
      if (thread.ask.ask_id !== ask.ask_id) return thread
      found = true
      return { ...thread, ask }
    }),
  }))
  return found ? { ...data, pages } : undefined
}
