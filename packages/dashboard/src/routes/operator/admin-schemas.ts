/**
 * Admin-listener responses (PROTOCOL §9, DASHBOARD §10). The protocol package defines no admin
 * schemas, so they are composed here from its building blocks; every response is validated.
 */
import { IdSchema, NameSchema, RoomSchema } from '@agent-peers/protocol'
import { z } from 'zod'

const Count = z.number().int().nonnegative()
const Timestamp = z.number().int().nonnegative()

export const REGISTRATION_MODES = ['invite-only', 'open'] as const
export const RegistrationSchema = z.enum(REGISTRATION_MODES)
export type Registration = z.infer<typeof RegistrationSchema>

export const WhoamiSchema = z.object({ admin: z.literal(true) })

export const HubStatusSchema = z.object({
  version: z.string(),
  public_url: z.string().nullable(),
  registration: RegistrationSchema,
  started_at: Timestamp,
  uptime_ms: Count,
  connections: Count,
  sessions_attached: Count,
  rooms: Count,
  members: Count,
  sessions_online: Count,
})
export type HubStatus = z.infer<typeof HubStatusSchema>

export const RateLimitsSchema = z.object({
  redeem: Count,
  preview: Count,
  register: Count,
  login: Count,
})
export type RateLimits = z.infer<typeof RateLimitsSchema>

export const HubSettingsSchema = z.object({
  public_url: z.string().nullable(),
  registration: RegistrationSchema,
  allow_room_creation: z.boolean(),
  retention_ms: Count,
  messages_per_minute: Count,
  rate_limits: RateLimitsSchema,
  heartbeat_ms: Count,
  grace_ms: Count,
  public_bind: z.string(),
  admin_bind: z.string(),
  version: z.string(),
})
export type HubSettings = z.infer<typeof HubSettingsSchema>

/** `PATCH /v0/admin/settings`: only these two change at runtime. */
export interface SettingsPatch {
  readonly public_url?: string
  readonly registration?: Registration
}

export const AdminRoomSchema = z.object({
  room: RoomSchema,
  people: Count,
  agents: Count,
  open_asks: Count,
  pending_knocks: Count,
  last_activity_at: Timestamp.nullable(),
})
export type AdminRoom = z.infer<typeof AdminRoomSchema>
export const AdminRoomsSchema = z.object({ rooms: z.array(AdminRoomSchema) })

export const AdminMemberSchema = z.object({
  member_id: IdSchema,
  name: NameSchema,
  created_at: Timestamp,
  rooms: Count,
  sessions: Count,
})
export type AdminMember = z.infer<typeof AdminMemberSchema>
export const AdminMembersSchema = z.object({ members: z.array(AdminMemberSchema) })

export const RevokeResultSchema = z.object({ revoked: Count })

export const RotateResultSchema = z.object({ admin_token: z.string().min(1), persisted: z.boolean() })
export type RotateResult = z.infer<typeof RotateResultSchema>

export const OkSchema = z.object({ ok: z.literal(true) })
