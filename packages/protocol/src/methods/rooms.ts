/** Room, invite and knock methods (§2.1, §6.4, §10). */
import { z } from 'zod'
import { SessionCardSchema } from '../card'
import { MAX_KNOCK_NOTE_CHARS, MAX_LINE_CHARS, MAX_SEARCH_QUERY_CHARS, MAX_TITLE_CHARS } from '../constants'
import { KnockDecisionSchema, RoleSchema, RoomSchema } from '../room'
import { EmptySchema, IdSchema, lineSchema, NameSchema, TimestampSchema } from '../schema-util'
import { RoomEntrySchema } from './session'

const sessionScoped = { session_id: IdSchema }
const roomScoped = { ...sessionScoped, room_id: IdSchema }
export const RoomScopedSchema = z.object(roomScoped)

export const MemberEntrySchema = z.object({ room_id: IdSchema, handle: NameSchema, card: SessionCardSchema })
export type MemberEntry = z.infer<typeof MemberEntrySchema>

const joinOptions = { ...sessionScoped, handle: NameSchema.optional(), takeover: z.boolean().optional() }
const absent = z.undefined().optional()

/** `room.join` names its room by exactly one of `room_id`, `room_name` or `invite_code`. */
export const RoomJoinParamsSchema = z.union([
  z.object({ ...joinOptions, room_id: IdSchema, room_name: absent, invite_code: absent }),
  z.object({ ...joinOptions, room_name: NameSchema, room_id: absent, invite_code: absent }),
  z.object({ ...joinOptions, invite_code: z.string().min(1).max(64), room_id: absent, room_name: absent }),
])

export const RoomJoinResultSchema = z.object({
  room: RoomSchema,
  handle: NameSchema,
  members: z.array(MemberEntrySchema),
})

export const SearchRoomSchema = z.object({
  room_id: IdSchema,
  name: NameSchema,
  display_name: z.string().optional(),
  owner: NameSchema,
  member_count: z.number().int().nonnegative(),
  my_state: z.enum(['none', 'member', 'knocking']),
})
export type SearchRoom = z.infer<typeof SearchRoomSchema>

export const RoomSearchParamsSchema = z.object({
  ...sessionScoped,
  q: z.string().max(MAX_SEARCH_QUERY_CHARS),
})
export const RoomSearchResultSchema = z.object({ rooms: z.array(SearchRoomSchema) })

export const KnockNoteSchema = lineSchema(MAX_KNOCK_NOTE_CHARS)
export const RoomKnockParamsSchema = z.object({ ...roomScoped, note: KnockNoteSchema.optional() })
export const RoomKnockResultSchema = z.object({ knock_id: IdSchema })

export const KnockWithdrawParamsSchema = z.object({ ...sessionScoped, knock_id: IdSchema })
export const KnockDecideParamsSchema = z.object({
  ...sessionScoped,
  knock_id: IdSchema,
  decision: KnockDecisionSchema,
})

export const RoomRemoveSessionParamsSchema = z.object({ ...roomScoped, target_session_id: IdSchema })

/** `invite.rotate` / `invite.close` / `invite.reopen` results. */
export const InviteChangeResultSchema = z.object({
  invite_url: z.string().optional(),
  join_prompt: z.string().optional(),
})

export const DescriptionSchema = lineSchema(MAX_LINE_CHARS)
export const DisplayNameSchema = lineSchema(MAX_TITLE_CHARS)

export const RoomCreateParamsSchema = z.object({
  ...sessionScoped,
  name: NameSchema,
  description: DescriptionSchema.optional(),
  handle: NameSchema.optional(),
  /** Optional additions used by the dashboard (DASHBOARD §4.2). */
  display_name: DisplayNameSchema.optional(),
  discoverable: z.boolean().optional(),
})
export const RoomCreateResultSchema = z.object({
  room: RoomSchema,
  handle: NameSchema,
  invite_url: z.string(),
  join_prompt: z.string().optional(),
})

export const InviteLangSchema = z.enum(['en', 'zh'])
export type InviteLang = z.infer<typeof InviteLangSchema>

export const InviteCreateParamsSchema = z.object({
  ...roomScoped,
  uses: z.number().int().positive().optional(),
  expires_ms: z.number().int().positive().optional(),
  role: RoleSchema.exclude(['owner']).optional(),
  lang: InviteLangSchema.optional(),
  suggested_handle: NameSchema.optional(),
})
export const InviteCreateResultSchema = z.object({
  invite_url: z.string(),
  expires_at: TimestampSchema.nullable(),
  join_prompt: z.string(),
  join_command: z.string(),
})

export const RoomKickParamsSchema = z.object({ ...roomScoped, member: NameSchema })

export const RoomListResultSchema = z.object({ rooms: z.array(RoomEntrySchema) })

export const PeersListParamsSchema = z.object({ ...sessionScoped, room_id: IdSchema.optional() })
export const PeersListResultSchema = z.object({ members: z.array(MemberEntrySchema) })

export const roomMethods = {
  'room.join': { params: RoomJoinParamsSchema, result: RoomJoinResultSchema },
  'room.search': { params: RoomSearchParamsSchema, result: RoomSearchResultSchema },
  'room.knock': { params: RoomKnockParamsSchema, result: RoomKnockResultSchema },
  'knock.withdraw': { params: KnockWithdrawParamsSchema, result: EmptySchema },
  'knock.decide': { params: KnockDecideParamsSchema, result: EmptySchema },
  'room.remove_session': { params: RoomRemoveSessionParamsSchema, result: EmptySchema },
  'room.exit': { params: RoomScopedSchema, result: EmptySchema },
  'room.dissolve': { params: RoomScopedSchema, result: EmptySchema },
  'invite.rotate': { params: RoomScopedSchema, result: InviteChangeResultSchema },
  'invite.close': { params: RoomScopedSchema, result: InviteChangeResultSchema },
  'invite.reopen': { params: RoomScopedSchema, result: InviteChangeResultSchema },
  'room.create': { params: RoomCreateParamsSchema, result: RoomCreateResultSchema },
  'invite.create': { params: InviteCreateParamsSchema, result: InviteCreateResultSchema },
  'room.kick': { params: RoomKickParamsSchema, result: EmptySchema },
  'room.leave': { params: RoomScopedSchema, result: EmptySchema },
  'room.list': { params: z.object(sessionScoped), result: RoomListResultSchema },
  'peers.list': { params: PeersListParamsSchema, result: PeersListResultSchema },
} as const
