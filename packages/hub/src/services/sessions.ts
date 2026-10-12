/**
 * Sessions (§4): open, reattach, revive (closed sessions too), supersede, close and update.
 * Identity is (member, host, agent_kind, local_key); the member token plus the tuple are the proof.
 */
import { isPeersError, type ParsedParamsOf, type Room, type SessionCard } from '@agent-peers/protocol'
import type { SessionRow } from '../storage/repos/sessions'
import type { Access } from './access'
import type { Cards } from './cards'
import { mergeCard, parseStoredCard, serializeCard, storedCardFrom } from './cards'
import type { Claims } from './claims'
import type { Effects, ServiceDeps } from './context'
import type { Presence } from './presence'

export interface OpenContext {
  readonly memberId: string
  /** The bridge's adapter is older than `min_adapter` (§4). */
  readonly outdated: boolean
}

export type OpenedRoom =
  | { readonly room: Room; readonly room_id: string; readonly handle: string; readonly status: 'joined' }
  | { readonly room_id: string; readonly handle: string; readonly status: 'held' }

export interface OpenResult {
  readonly session_id: string
  readonly rooms: readonly OpenedRoom[]
}

export function createSessions(
  deps: ServiceDeps,
  access: Access,
  cards: Cards,
  claims: Claims,
  presence: Presence,
) {
  const { repos } = deps

  const upsert = (ctx: OpenContext, params: ParsedParamsOf<'session.open'>): SessionRow => {
    const card = storedCardFrom(params.card)
    const identity = {
      member_id: ctx.memberId,
      host: card.host,
      agent_kind: card.agent.kind,
      local_key: params.local_key,
    }
    const existing = repos.sessions.byIdentity(identity)
    const now = deps.now()
    if (existing) {
      const merged = mergeCard(parseStoredCard(existing.card_json), card)
      repos.sessions.reopen(existing.id, serializeCard(merged), ctx.outdated, now)
      return repos.sessions.byId(existing.id) as SessionRow
    }
    const id = deps.newId()
    repos.sessions.insert({
      ...identity,
      id,
      card_json: serializeCard(card),
      connection: 'offline',
      outdated: ctx.outdated ? 1 : 0,
      created_at: now,
      last_seen_at: now,
      last_activity_at: now,
    })
    return repos.sessions.byId(id) as SessionRow
  }

  /** §4 continuity: the old session's handles and non-working asks move here, then it closes. */
  const supersede = (fx: Effects, session: SessionRow, oldLocalKey: string): void => {
    const old = repos.sessions.byIdentity({
      member_id: session.member_id,
      host: session.host,
      agent_kind: session.agent_kind,
      local_key: oldLocalKey,
    })
    if (!old || old.id === session.id) return
    for (const entry of repos.sessionRooms.forSession(old.id)) {
      repos.sessionRooms.delete(old.id, entry.room_id)
      if (repos.handles.bySession(session.id, entry.room_id)) continue
      const held = repos.handles.get(entry.room_id, entry.handle)
      if (held?.session_id === old.id) repos.handles.setHolder(entry.room_id, entry.handle, session.id)
      repos.sessionRooms.upsert(session.id, entry.room_id, entry.handle)
    }
    presence.goOffline(fx, old.id, true)
    fx.after(() => deps.link.detach(old.id))
  }

  /** Re-claims the session's rooms under the §2.1 rules; rooms held by a live session are `held`. */
  const reclaim = (fx: Effects, session: SessionRow): readonly OpenedRoom[] =>
    repos.sessionRooms.forSession(session.id).flatMap((entry): OpenedRoom[] => {
      const room = repos.rooms.byId(entry.room_id)
      if (!room || room.dissolved_at !== null || !access.activeGrant(room.id, session.member_id)) {
        repos.sessionRooms.delete(session.id, entry.room_id)
        return []
      }
      try {
        const claimed = claims.claim(fx, { sessionId: session.id, roomId: room.id, handle: entry.handle })
        return [{ room: access.wireRoom(room), room_id: room.id, handle: claimed.handle, status: 'joined' }]
      } catch (error) {
        if (isPeersError(error, 'handle_taken'))
          return [{ room_id: room.id, handle: entry.handle, status: 'held' }]
        throw error
      }
    })

  const open = (ctx: OpenContext, params: ParsedParamsOf<'session.open'>): OpenResult =>
    deps.tx((fx) => {
      const session = upsert(ctx, params)
      if (params.supersedes !== undefined && params.supersedes !== params.local_key) {
        supersede(fx, session, params.supersedes)
      }
      const wasOffline = presence.online(fx, session.id, false) || session.closed_at !== null
      const rooms = reclaim(fx, session)
      if (wasOffline) presence.announce(fx, session.id)
      return { session_id: session.id, rooms }
    })

  const close = (sessionId: string): void =>
    deps.tx((fx) => {
      access.requireSession(sessionId)
      presence.goOffline(fx, sessionId, true)
      fx.after(() => deps.link.detach(sessionId))
    })

  const update = (sessionId: string, patch: Omit<ParsedParamsOf<'session.update'>, 'session_id'>): void => {
    deps.tx(() => {
      const row = access.requireSession(sessionId)
      const card = parseStoredCard(row.card_json)
      const activityChanged = patch.activity !== undefined && patch.activity !== card.activity
      const next = mergeCard(card, patch)
      repos.sessions.updateCard(
        sessionId,
        serializeCard(next),
        activityChanged ? deps.now() : row.last_activity_at,
      )
    })
    presence.changed(sessionId)
  }

  const listOutdated = (): readonly SessionCard[] =>
    repos.sessions
      .list()
      .filter((s) => s.outdated === 1 && s.closed_at === null)
      .map(cards.build)

  return { open, close, update, listOutdated, reclaim }
}
export type Sessions = ReturnType<typeof createSessions>
