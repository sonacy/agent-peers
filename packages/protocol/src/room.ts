/** Rooms, grants, knocks and invites (§2, §8, §10). */
import { z } from 'zod'
import { MAX_LINE_CHARS, MAX_TITLE_CHARS } from './constants'
import { IdSchema, NameSchema, TimestampSchema } from './schema-util'

export const ROLES = ['owner', 'member', 'readonly'] as const
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>

export const RoomSchema = z.object({
  room_id: IdSchema,
  /** Unique slug per hub. */
  name: NameSchema,
  display_name: z
    .string()
    .max(MAX_TITLE_CHARS * 2)
    .optional(),
  description: z
    .string()
    .max(MAX_LINE_CHARS * 2)
    .optional(),
  discoverable: z.boolean().optional(),
  /** The owner's member name. */
  owner: NameSchema.optional(),
  created_at: TimestampSchema.optional(),
})
export type Room = z.infer<typeof RoomSchema>

export const GrantSchema = z.object({
  member_id: IdSchema,
  member: NameSchema,
  room_id: IdSchema,
  role: RoleSchema,
  created_at: TimestampSchema,
  revoked_at: TimestampSchema.nullable(),
})
export type Grant = z.infer<typeof GrantSchema>

export const KNOCK_STATES = ['pending', 'accepted', 'declined', 'withdrawn', 'expired'] as const
export const KnockStateSchema = z.enum(KNOCK_STATES)
export type KnockState = z.infer<typeof KnockStateSchema>

export const KnockDecisionSchema = z.enum(['accept', 'decline'])
export type KnockDecision = z.infer<typeof KnockDecisionSchema>

export const KnockSchema = z.object({
  knock_id: IdSchema,
  room_id: IdSchema,
  member: NameSchema,
  member_id: IdSchema.optional(),
  note: z.string().nullish(),
  state: KnockStateSchema,
  created_at: TimestampSchema,
  expires_at: TimestampSchema,
  decided_at: TimestampSchema.nullish(),
  /** §10.2: the knocker was kicked from this room before. */
  previously_removed: z.boolean().optional(),
})
export type Knock = z.infer<typeof KnockSchema>

export const INVITE_STATES = ['active', 'closed'] as const
export const InviteStateSchema = z.enum(INVITE_STATES)
export type InviteState = z.infer<typeof InviteStateSchema>

/** A room's invite as owners see it (§10.1). The code is only ever shown masked. */
export const InviteSchema = z.object({
  room_id: IdSchema,
  state: InviteStateSchema,
  /** `inv_••••••••7H58` */
  code_masked: z.string(),
  role: RoleSchema,
  created_at: TimestampSchema,
  uses_left: z.number().int().nonnegative().nullish(),
  expires_at: TimestampSchema.nullish(),
  /** §10.1: the join prompt would point at a loopback address. */
  loopback: z.boolean().optional(),
})
export type Invite = z.infer<typeof InviteSchema>

const MASK = '•'.repeat(8)

/** `maskInviteCode("7K3QX9TZ4M2B7H58")` → `"inv_••••••••7H58"` (§8). */
export function maskInviteCode(code: string): string {
  return `inv_${MASK}${code.slice(-4)}`
}
