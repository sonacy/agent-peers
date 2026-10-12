/** Read models for the member dashboard (DASHBOARD §11): my rooms, room detail and the Q&A feed. */
import type {
  AskFilter,
  AsksResponseSchema,
  DeepReadonly,
  MyRoomsResponseSchema,
  RoomDetailResponseSchema,
  SessionCard,
} from '@agent-peers/protocol'
import type { z } from 'zod'
import type { AskRow } from '../storage/repos/asks'
import type { RoomRow } from '../storage/repos/rooms'
import type { Access, Actor } from './access'
import type { Cards } from './cards'
import type { ServiceDeps } from './context'
import type { Invites } from './invites'
import type { Knocks } from './knocks'
import type { Membership } from './membership'
import { toAskRecord, toWireMessage } from './wire'

export type MyRoom = DeepReadonly<z.input<typeof MyRoomsResponseSchema>['rooms'][number]>
export type RoomDetail = DeepReadonly<z.input<typeof RoomDetailResponseSchema>>
export type AsksPage = DeepReadonly<z.input<typeof AsksResponseSchema>>

const FEED_PAGE = 20
const FEED_SCAN = 100

export function createQueries(
  deps: ServiceDeps,
  access: Access,
  cards: Cards,
  invites: Invites,
  knocks: Knocks,
  membership: Membership,
) {
  const { repos } = deps

  const agentsIn = (roomId: string, memberId?: string): readonly { handle: string; card: SessionCard }[] =>
    (memberId === undefined
      ? repos.handles.forRoom(roomId)
      : repos.handles.forMemberInRoom(roomId, memberId)
    ).flatMap((h) => {
      const card = h.session_id === null ? undefined : cards.byId(h.session_id)
      return card ? [{ handle: h.handle, card }] : []
    })

  const myRooms = (memberId: string): readonly MyRoom[] =>
    repos.grants.activeForMember(memberId).map((grant) => {
      const room = repos.rooms.byId(grant.room_id) as RoomRow
      return {
        room: access.wireRoom(room),
        role: grant.role,
        people: repos.grants.countActive(room.id),
        agents: agentsIn(room.id).length,
        open_asks: repos.asks.openInRoom(room.id).length,
        ...(grant.role === 'owner' ? { pending_knocks: repos.knocks.pendingForRoom(room.id).length } : {}),
        last_activity_at: repos.messages.lastTs(room.id) ?? null,
      }
    })

  const people = (roomId: string, me: string | undefined) =>
    repos.grants
      .activeForRoom(roomId)
      .map((g) => {
        const agents = agentsIn(roomId, g.member_id)
        const last = agents.reduce<number | null>(
          (max, a) => Math.max(max ?? 0, a.card.last_activity_at),
          null,
        )
        return {
          member_id: g.member_id,
          member: g.member_name,
          role: g.role,
          is_me: g.member_id === me,
          agents,
          last_activity_at: last,
        }
      })
      .toSorted(
        (a, b) => Number(b.is_me) - Number(a.is_me) || (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0),
      )

  /** Members grouped by person, my role, and owner extras (invite, knocks, kicked). */
  const roomDetail = (actor: Actor, roomId: string): RoomDetail => {
    const room = access.requireRoom(roomId)
    const me = actor.kind === 'admin' ? undefined : actor.memberId
    const role = me === undefined ? 'owner' : access.requireGrant(roomId, me).role
    const base = { room: access.wireRoom(room), my_role: role, people: people(roomId, me) }
    if (!access.isOwner(actor, roomId)) return base
    return {
      ...base,
      invite: invites.view(roomId),
      join_prompt: invites.promptFor(roomId),
      knocks: [...knocks.pendingForRoom(actor, roomId)],
      kicked: [...membership.kicked(actor, roomId)],
    }
  }

  const matches = (ask: AskRow, memberId: string, filter: AskFilter): boolean => {
    if (filter === 'mine') return ask.from_member_id === memberId
    if (filter === 'to_me') return repos.handles.get(ask.room_id, ask.to_handle)?.member_id === memberId
    return true
  }

  const thread = (ask: AskRow): AsksPage['asks'][number] | undefined => {
    const question = repos.messages.byId(ask.id)
    const room = repos.rooms.byId(ask.room_id)
    if (!question || !room) return undefined
    const answer = repos.messages.forAsk(ask.id).findLast((m) => m.kind === 'reply')
    const from = repos.handles.get(ask.room_id, ask.from_handle)?.session_id ?? question.from_session
    const to = ask.assignee_session ?? repos.handles.get(ask.room_id, ask.to_handle)?.session_id ?? null
    return {
      ask: toAskRecord(ask),
      room: { room_id: room.id, name: room.name },
      question: toWireMessage(question, ask),
      answer: answer ? toWireMessage(answer, ask) : null,
      from: from ? (cards.byId(from) ?? null) : null,
      to: to ? (cards.byId(to) ?? null) : null,
    }
  }

  /** The Q&A feed across the member's rooms, newest first, paged by ask id. */
  const asksFeed = (memberId: string, filter: AskFilter, cursor?: string): AsksPage => {
    const roomIds = repos.grants.activeForMember(memberId).map((g) => g.room_id)
    const scanned = repos.asks.listForRooms(roomIds, cursor, FEED_SCAN)
    const picked = scanned.filter((a) => matches(a, memberId, filter)).slice(0, FEED_PAGE)
    const last = picked.at(-1)
    const more = picked.length === FEED_PAGE || scanned.length === FEED_SCAN
    const next = more ? (picked.length === FEED_PAGE ? last?.id : scanned.at(-1)?.id) : undefined
    return { asks: picked.flatMap((a) => thread(a) ?? []), next_cursor: next ?? null }
  }

  const me = (memberId: string) => {
    const member = repos.members.byId(memberId)
    return member ? { member_id: member.id, name: member.name, created_at: member.created_at } : undefined
  }

  return { myRooms, roomDetail, asksFeed, me, agentsIn }
}
export type Queries = ReturnType<typeof createQueries>
