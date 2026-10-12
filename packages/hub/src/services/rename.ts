/**
 * Renaming (§2.2): titles change the card; handle renames move open asks (to and from), the chat
 * cursor and the session's room intent in one transaction, and log `@old is now @new`.
 */
import { PeersError, type SessionCard } from '@agent-peers/protocol'
import type { Access, Actor } from './access'
import type { Cards } from './cards'
import { mergeCard, parseStoredCard, serializeCard } from './cards'
import type { Effects, ServiceDeps } from './context'
import type { Messages } from './messages'
import type { Presence } from './presence'

export interface RenameInput {
  readonly title?: string
  readonly handle?: string
  readonly room_id?: string
}

export interface RenamedRoom {
  readonly room_id: string
  readonly old: string
  readonly new: string
}

export interface RenameResult {
  readonly title: string | null
  readonly rooms: readonly RenamedRoom[]
}

export interface SessionPatchInput extends RenameInput {
  readonly accepting?: boolean
}

type By = string | { readonly member?: string; readonly session_id?: string }

export function createRename(
  deps: ServiceDeps,
  access: Access,
  cards: Cards,
  messages: Messages,
  presence: Presence,
) {
  const { repos } = deps

  const byOf = (actor: Actor): By => {
    if (actor.kind === 'admin') return 'admin'
    if (actor.kind === 'session') return { session_id: actor.sessionId }
    return { member: repos.members.byId(actor.memberId)?.name ?? actor.memberId }
  }

  const requireOwnSession = (actor: Actor, sessionId: string) => {
    const session = access.requireSession(sessionId)
    const allowed =
      actor.kind === 'admin' ||
      (actor.kind === 'session' ? actor.sessionId === sessionId : actor.memberId === session.member_id)
    if (!allowed) throw new PeersError('forbidden', 'not your session')
    return session
  }

  /** Moves one handle to a new name inside the caller's transaction. */
  const renameOne = (fx: Effects, roomId: string, from: string, to: string, by: By): RenamedRoom => {
    if (repos.handles.get(roomId, to)) throw new PeersError('rename_conflict', `@${to} is taken in this room`)
    const row = repos.handles.get(roomId, from)
    repos.handles.rename(roomId, from, to)
    repos.asks.renameHandle(roomId, from, to)
    repos.cursors.rename(roomId, from, to)
    repos.sessionRooms.renameHandle(roomId, from, to)
    messages.system(fx, roomId, `@${from} is now @${to}`)
    if (row?.session_id)
      fx.notify(row.session_id, 'handle.renamed', { room_id: roomId, old: from, new: to, by })
    return { room_id: roomId, old: from, new: to }
  }

  const setTitle = (fx: Effects, sessionId: string, title: string): void => {
    const row = access.requireSession(sessionId)
    const card = mergeCard(parseStoredCard(row.card_json), { title })
    repos.sessions.updateCard(sessionId, serializeCard(card), row.last_activity_at)
    fx.notify(sessionId, 'session.patched', { title })
  }

  const rename = (actor: Actor, sessionId: string, input: RenameInput): RenameResult =>
    deps.tx((fx) => {
      requireOwnSession(actor, sessionId)
      if (input.title !== undefined) setTitle(fx, sessionId, input.title)
      const handles =
        input.handle === undefined
          ? []
          : input.room_id !== undefined
            ? [access.requireHandle(sessionId, input.room_id)]
            : repos.handles.forSession(sessionId)
      const by = byOf(actor)
      const rooms = handles
        .filter((h) => h.handle !== input.handle)
        .map((h) => renameOne(fx, h.room_id, h.handle, input.handle as string, by))
      presence.announce(fx, sessionId)
      const title = parseStoredCard(access.requireSession(sessionId).card_json).title ?? null
      return { title, rooms }
    })

  /** Owner or admin rename (`PATCH …/handles/:handle`); the handle's own member may also do it. */
  const renameHandle = (actor: Actor, roomId: string, from: string, to: string): RenamedRoom =>
    deps.tx((fx) => {
      access.requireRoom(roomId)
      const row = repos.handles.get(roomId, from)
      if (!row) throw new PeersError('target_not_found', `no @${from} in this room`)
      const own = actor.kind !== 'admin' && actor.memberId === row.member_id
      if (!own && !access.isOwner(actor, roomId))
        throw new PeersError('forbidden', 'only the owner may rename')
      if (from === to) return { room_id: roomId, old: from, new: to }
      const renamed = renameOne(fx, roomId, from, to, byOf(actor))
      if (row.session_id) presence.announce(fx, row.session_id)
      access.audit(actor, 'handle.rename', roomId, { from, to })
      return renamed
    })

  /** Dashboard `PATCH /v0/me/sessions/:id` (§9): accepting, title and handle. */
  const patch = (actor: Actor, sessionId: string, input: SessionPatchInput): SessionCard =>
    deps.tx((fx) => {
      const session = requireOwnSession(actor, sessionId)
      if (input.accepting !== undefined) {
        const card = mergeCard(parseStoredCard(session.card_json), { accepting: input.accepting })
        repos.sessions.updateCard(sessionId, serializeCard(card), session.last_activity_at)
        fx.notify(sessionId, 'session.patched', { accepting: input.accepting })
      }
      if (input.title !== undefined || input.handle !== undefined) {
        rename(actor, sessionId, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.handle !== undefined ? { handle: input.handle } : {}),
          ...(input.room_id !== undefined ? { room_id: input.room_id } : {}),
        })
      } else presence.announce(fx, sessionId)
      return cards.build(access.requireSession(sessionId))
    })

  return { rename, renameHandle, patch }
}
export type Rename = ReturnType<typeof createRename>
