/** Member API (§9, DASHBOARD §11): request bodies, responses and SSE event payloads. */
import { z } from 'zod'
import { SessionCardSchema, TitleSchema } from './card'
import { type ErrorCode, isErrorCode } from './errors'
import { AskRecordSchema, MessageSchema } from './message'
import { DescriptionSchema, DisplayNameSchema, KnockNoteSchema, SearchRoomSchema } from './methods/rooms'
import { InviteSchema, KnockDecisionSchema, KnockSchema, RoleSchema, RoomSchema } from './room'
import { IdSchema, NameSchema, TimestampSchema } from './schema-util'
import type { DeepReadonly } from './types'

export const MEMBER_API_PREFIX = '/v0/me'
export const ROOM_SEARCH_PATH = '/v0/rooms/search'
export const MEMBER_EVENTS_PATH = '/v0/me/events'

// ---- GET ------------------------------------------------------------------------------------------

export const MeResponseSchema = z.object({
  member_id: IdSchema,
  name: NameSchema,
  created_at: TimestampSchema,
})

export const SessionsResponseSchema = z.object({ sessions: z.array(SessionCardSchema) })

/** One row of `GET /v0/me/rooms`. */
export const MyRoomSchema = z.object({
  room: RoomSchema,
  role: RoleSchema,
  people: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  open_asks: z.number().int().nonnegative().default(0),
  /** Owners only. */
  pending_knocks: z.number().int().nonnegative().optional(),
  last_activity_at: TimestampSchema.nullable(),
})
export const MyRoomsResponseSchema = z.object({ rooms: z.array(MyRoomSchema) })

/** A session in a room, with the handle it holds there. */
export const RoomAgentSchema = z.object({ handle: NameSchema, card: SessionCardSchema })

/** Room members grouped by person (DASHBOARD §4.3). */
export const RoomPersonSchema = z.object({
  member_id: IdSchema,
  member: NameSchema,
  role: RoleSchema,
  is_me: z.boolean(),
  agents: z.array(RoomAgentSchema),
  last_activity_at: TimestampSchema.nullable(),
})

export const KickedMemberSchema = z.object({
  member_id: IdSchema,
  member: NameSchema,
  kicked_at: TimestampSchema,
})

export const RoomDetailResponseSchema = z.object({
  room: RoomSchema,
  my_role: RoleSchema,
  people: z.array(RoomPersonSchema),
  /** Owner extras. */
  invite: InviteSchema.nullish(),
  join_prompt: z.string().nullish(),
  knocks: z.array(KnockSchema).optional(),
  kicked: z.array(KickedMemberSchema).optional(),
})

export const AskFilterSchema = z.enum(['all', 'mine', 'to_me'])
export type AskFilter = z.infer<typeof AskFilterSchema>
export const AsksQuerySchema = z.object({
  filter: AskFilterSchema.default('all'),
  cursor: z.string().max(128).optional(),
})

/** One Q&A thread (DASHBOARD §4.4). */
export const AskThreadSchema = z.object({
  ask: AskRecordSchema,
  room: z.object({ room_id: IdSchema, name: NameSchema }),
  question: MessageSchema,
  answer: MessageSchema.nullish(),
  from: SessionCardSchema.nullish(),
  to: SessionCardSchema.nullish(),
})
export const AsksResponseSchema = z.object({
  asks: z.array(AskThreadSchema),
  next_cursor: z.string().nullable(),
})

export const RoomSearchQuerySchema = z.object({ q: z.string().max(100) })
export const RoomSearchResponseSchema = z.object({ rooms: z.array(SearchRoomSchema) })

// ---- POST / PATCH -----------------------------------------------------------------------------------

export const LoginBodySchema = z.object({ code: z.string().min(1).max(128) })

export const CreateRoomBodySchema = z.object({
  name: NameSchema,
  display_name: DisplayNameSchema.optional(),
  description: DescriptionSchema.optional(),
  discoverable: z.boolean().default(true),
})
export const CreateRoomResponseSchema = z.object({
  room: RoomSchema,
  invite: InviteSchema,
  invite_url: z.string(),
  join_prompt: z.string(),
})

export const KnockBodySchema = z.object({ note: KnockNoteSchema.optional() })
export const KnockResponseSchema = z.object({ knock: KnockSchema })

export const DecideBodySchema = z.object({ decision: KnockDecisionSchema })

/** `POST rooms/:id/invite/rotate|close|reopen`. */
export const InviteActionResponseSchema = z.object({
  invite: InviteSchema.nullable(),
  invite_url: z.string().nullish(),
  join_prompt: z.string().nullish(),
})

export const PatchSessionBodySchema = z
  .object({
    accepting: z.boolean().optional(),
    title: TitleSchema.optional(),
    handle: NameSchema.optional(),
    room_id: IdSchema.optional(),
  })
  .refine((b) => b.room_id === undefined || b.handle !== undefined, 'room_id applies to a handle rename')
export const PatchSessionResponseSchema = z.object({ session: SessionCardSchema })

/** Empty success body for actions with nothing to return. */
export const OkResponseSchema = z.object({ ok: z.literal(true) })

/** Every member-API failure: `{ error: { code, message, retry_after_ms? } }`. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().refine(isErrorCode, 'unknown error code'),
    message: z.string(),
    retry_after_ms: z.number().int().nonnegative().optional(),
  }),
})
export type ErrorBody = {
  readonly error: { readonly code: ErrorCode; readonly message: string; readonly retry_after_ms?: number }
}

// ---- SSE (`GET /v0/me/events`) ----------------------------------------------------------------------

export const ROOM_EVENT_CHANGES = ['created', 'updated', 'invite', 'members', 'removed', 'dissolved'] as const

export const MEMBER_EVENTS = {
  presence: z.object({ room_id: IdSchema, handle: NameSchema, card: SessionCardSchema }),
  session: z.object({ session: SessionCardSchema }),
  room: z.object({ room_id: IdSchema, change: z.enum(ROOM_EVENT_CHANGES), room: RoomSchema.optional() }),
  knock: z.object({ knock: KnockSchema }),
  ask: z.object({ ask: AskRecordSchema }),
  message: z.object({ message: MessageSchema }),
} as const

export type MemberEventName = keyof typeof MEMBER_EVENTS
export type MemberEventOf<E extends MemberEventName> = DeepReadonly<z.output<(typeof MEMBER_EVENTS)[E]>>

export function isMemberEventName(name: unknown): name is MemberEventName {
  return typeof name === 'string' && Object.hasOwn(MEMBER_EVENTS, name)
}

/** One SSE frame: `id:` (optional), `event:` and a single-line JSON `data:`. */
export function encodeMemberEvent<E extends MemberEventName>(
  name: E,
  data: DeepReadonly<z.input<(typeof MEMBER_EVENTS)[E]>>,
  id?: string,
): string {
  const idLine = id === undefined ? '' : `id: ${id.replace(/[\r\n]/g, '')}\n`
  return `${idLine}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Parses an SSE event's `data`; undefined for unknown events or bad payloads (§11: ignore). */
export function parseMemberEvent<E extends MemberEventName>(
  name: E,
  data: string,
): MemberEventOf<E> | undefined {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  const parsed = MEMBER_EVENTS[name].safeParse(value)
  return parsed.success ? (parsed.data as MemberEventOf<E>) : undefined
}
