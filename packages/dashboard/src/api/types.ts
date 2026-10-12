/**
 * Data types of the member API (PROTOCOL §9, DASHBOARD §11), derived from the protocol zod schemas so
 * the dashboard and the hub can never drift apart.
 */
import type {
  AskFilter,
  AsksResponseSchema,
  AskThreadSchema,
  CreateRoomResponseSchema,
  InviteActionResponseSchema,
  KnockResponseSchema,
  MeResponseSchema,
  MyRoomSchema,
  RoomAgentSchema,
  RoomDetailResponseSchema,
  RoomPersonSchema,
  SearchRoom,
  SessionCard,
} from '@agent-peers/protocol'

/** Anything with a zod-style `parse`; its return type is the validated output. */
export interface ParseSchema {
  parse(value: unknown): unknown
}
export type Parsed<S extends ParseSchema> = ReturnType<S['parse']>

export type Me = Parsed<typeof MeResponseSchema>
export type MyRoom = Parsed<typeof MyRoomSchema>
export type RoomDetail = Parsed<typeof RoomDetailResponseSchema>
export type RoomPerson = Parsed<typeof RoomPersonSchema>
export type RoomAgent = Parsed<typeof RoomAgentSchema>
export type AskThread = Parsed<typeof AskThreadSchema>
export type AsksPage = Parsed<typeof AsksResponseSchema>
export type CreatedRoom = Parsed<typeof CreateRoomResponseSchema>
export type InviteActionResult = Parsed<typeof InviteActionResponseSchema>
export type KnockResult = Parsed<typeof KnockResponseSchema>
export type Knock = KnockResult['knock']
export type KickedMember = NonNullable<RoomDetail['kicked']>[number]
export type Invite = NonNullable<RoomDetail['invite']>

export type { AskFilter, SearchRoom, SessionCard }

export const INVITE_ACTIONS = ['rotate', 'close', 'reopen'] as const
export type InviteAction = (typeof INVITE_ACTIONS)[number]

/** `PATCH /v0/me/sessions/:id`: a handle rename needs the room it applies to. */
export interface SessionPatch {
  readonly accepting?: boolean
  readonly title?: string
  readonly handle?: string
  readonly room_id?: string
}

export interface CreateRoomInput {
  readonly name: string
  readonly display_name?: string
  readonly description?: string
  readonly discoverable?: boolean
}
