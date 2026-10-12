/**
 * Bodies and queries of the HTTP surfaces that the protocol package does not define as member-API
 * schemas (§8 redeem/register, §9 admin). Built from the protocol's building blocks.
 */
import {
  CreateRoomBodySchema,
  IdSchema,
  InviteLangSchema,
  MAX_HISTORY_LIMIT,
  NameSchema,
} from '@agent-peers/protocol'
import { z } from 'zod'

/** `POST /v0/invites/redeem { code, member_name }`; `member_name` is optional with a bearer token. */
export const RedeemBodySchema = z.object({
  code: z.string().min(1).max(64),
  member_name: NameSchema.optional(),
})

export const RegisterBodySchema = z.object({ member_name: NameSchema })

export const AdminLoginBodySchema = z.object({ token: z.string().min(1).max(512) })

export const SettingsPatchSchema = z.strictObject({
  public_url: z.string().min(1).max(2048).optional(),
  registration: z.enum(['invite-only', 'open']).optional(),
})

export const AdminCreateRoomBodySchema = CreateRoomBodySchema

export const AdminInviteBodySchema = z.object({
  lang: InviteLangSchema.optional(),
  suggested_handle: NameSchema.optional(),
})

export const RenameHandleBodySchema = z.object({ handle: NameSchema })

export const HistoryQuerySchema = z.object({
  before_seq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
})

/** Path parameters: hub ids, and member references (an id or a name). */
export const IdParamSchema = IdSchema
export const MemberRefSchema = IdSchema
export const HandleParamSchema = NameSchema

export const INVITE_ACTIONS = ['rotate', 'close', 'reopen'] as const
export const InviteActionSchema = z.enum(INVITE_ACTIONS)
