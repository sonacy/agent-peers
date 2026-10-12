/** Claiming and releasing handles (§2.1, §10.3). */
import { isValidName, nextFreeName, PeersError, toNameSlug } from '@agent-peers/protocol'
import type { HandleRow } from '../storage/repos/handles'
import type { SessionRow } from '../storage/repos/sessions'
import type { Access } from './access'
import type { Asks } from './asks'
import { parseStoredCard } from './cards'
import type { Effects, ServiceDeps } from './context'
import type { Messages } from './messages'
import type { Presence } from './presence'

export interface ClaimRequest {
  readonly sessionId: string
  readonly roomId: string
  /** Explicit handle: never suffixed. Omitted: the default handle, suffixed on conflict. */
  readonly handle?: string
  readonly takeover?: boolean
}

export interface ClaimResult {
  readonly handle: string
  /** True when this claim moved the handle to the session (asks and replay must be delivered). */
  readonly changed: boolean
}

export type ReleaseReason = 'left' | 'removed' | 'kicked' | 'exited' | 'dissolved'

const RELEASE_TEXT: Readonly<Record<ReleaseReason, string>> = {
  left: 'left',
  removed: 'was removed',
  kicked: 'was removed by the owner',
  exited: 'left the room',
  dissolved: 'left (room dissolved)',
}

export function createClaims(
  deps: ServiceDeps,
  access: Access,
  asks: Asks,
  messages: Messages,
  presence: Presence,
) {
  const { repos } = deps

  const holderOnline = (row: HandleRow, sessionId: string): boolean => {
    if (row.session_id === null || row.session_id === sessionId) return false
    const holder = repos.sessions.byId(row.session_id)
    return holder !== undefined && holder.closed_at === null && holder.connection === 'online'
  }

  /** Default handle (§2.1): host short name → workspace name → member name, suffixed on conflict. */
  const defaultHandle = (session: SessionRow, roomId: string): string => {
    const card = parseStoredCard(session.card_json)
    const member = repos.members.byId(session.member_id)?.name ?? 'agent'
    const candidates = [card.host.split('.')[0] ?? '', card.workspace?.name ?? '', member]
    const base = candidates.map((c) => (c ? toNameSlug(c, 'agent') : '')).find(isValidName) ?? member
    return nextFreeName(base, (name) => {
      const row = repos.handles.get(roomId, name)
      return row !== undefined && (row.member_id !== session.member_id || holderOnline(row, session.id))
    })
  }

  const takeFrom = (fx: Effects, row: HandleRow, sessionId: string, notifyLoser: boolean): void => {
    const loser = row.session_id
    if (loser === null) return
    const askIds = asks.handleLost(fx, row.room_id, row.handle, loser)
    // An online holder displaced by takeover is told (handle.lost) and drops the room. An offline or
    // stale holder keeps its room intent, so its revive reports the room `held` or re-claims it (§4).
    if (notifyLoser) repos.sessionRooms.delete(loser, row.room_id)
    repos.handles.setHolder(row.room_id, row.handle, sessionId)
    if (notifyLoser) {
      fx.notify(loser, 'handle.lost', {
        room_id: row.room_id,
        handle: row.handle,
        by: { session_id: sessionId },
        ask_ids: [...askIds],
      })
    }
    presence.announce(fx, loser)
  }

  const createHandle = (fx: Effects, session: SessionRow, roomId: string, handle: string): ClaimResult => {
    repos.handles.insert({
      room_id: roomId,
      handle,
      member_id: session.member_id,
      session_id: session.id,
      created_at: deps.now(),
    })
    repos.sessionRooms.upsert(session.id, roomId, handle)
    // The joiner gets no live frame before its join result and replay.done (§6.3); the cursor set
    // below starts after this notice, so it is not replayed to the joiner either.
    messages.system(fx, roomId, `@${handle} joined`, session.id)
    repos.cursors.delete(roomId, handle)
    messages.cursorFor(roomId, handle)
    return { handle, changed: true }
  }

  /** Applies the §2.1 table. Throws `handle_taken` with a suggested free name. */
  const claim = (fx: Effects, request: ClaimRequest): ClaimResult => {
    const session = access.requireSession(request.sessionId)
    // A session holds one handle per room; joining again keeps it (use session.rename to change it).
    const current = repos.handles.bySession(session.id, request.roomId)
    if (current) return { handle: current.handle, changed: false }
    const handle = request.handle ?? defaultHandle(session, request.roomId)
    const row = repos.handles.get(request.roomId, handle)
    if (!row) return createHandle(fx, session, request.roomId, handle)
    const online = holderOnline(row, session.id)
    if (row.member_id !== session.member_id || (online && request.takeover !== true)) {
      const suggestion = nextFreeName(handle, (name) => repos.handles.get(request.roomId, name) !== undefined)
      // same_member lets `agent-peers join` say "already joined as @h" instead of offering a suffix.
      throw new PeersError('handle_taken', `@${handle} is taken`, {
        handle,
        suggestion,
        same_member: row.member_id === session.member_id,
      })
    }
    takeFrom(fx, row, session.id, online)
    repos.handles.setHolder(request.roomId, handle, session.id)
    repos.sessionRooms.upsert(session.id, request.roomId, handle)
    messages.cursorFor(request.roomId, handle)
    return { handle, changed: true }
  }

  /** Releases a handle: open asks fail (`not_in_room`), cursor and intent are dropped (§6.2, §10.3). */
  const release = (
    fx: Effects,
    roomId: string,
    handle: string,
    reason: ReleaseReason,
  ): HandleRow | undefined => {
    const row = repos.handles.get(roomId, handle)
    if (!row) return undefined
    asks.failInvolving(fx, roomId, handle)
    repos.handles.delete(roomId, handle)
    repos.sessionRooms.deleteHandle(roomId, handle)
    repos.cursors.delete(roomId, handle)
    messages.system(fx, roomId, `@${handle} ${RELEASE_TEXT[reason]}`)
    if (row.session_id !== null) presence.announce(fx, row.session_id, [roomId])
    return row
  }

  /** Releases every handle a member holds in a room; returns the sessions that held them. */
  const releaseMember = (
    fx: Effects,
    roomId: string,
    memberId: string,
    reason: ReleaseReason,
  ): readonly string[] =>
    repos.handles.forMemberInRoom(roomId, memberId).flatMap((h) => {
      const released = release(fx, roomId, h.handle, reason)
      return released?.session_id ? [released.session_id] : []
    })

  return { claim, release, releaseMember, defaultHandle }
}
export type Claims = ReturnType<typeof createClaims>
