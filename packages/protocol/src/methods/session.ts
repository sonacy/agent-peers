/** Connection and session methods (§4, §2.2, §6.4). */
import { z } from 'zod'
import {
  ActivitySchema,
  AgentKindFieldSchema,
  CardInputSchema,
  InjectTierSchema,
  ModelSchema,
  SummarySchema,
  TitleSchema,
  WorkspaceSchema,
} from '../card'
import { MAX_LOCAL_KEY_LENGTH } from '../constants'
import { RoomSchema } from '../room'
import { EmptySchema, IdSchema, NameSchema, TimestampSchema } from '../schema-util'
import type { DeepReadonly } from '../types'

const sessionScoped = { session_id: IdSchema }
export const SessionScopedSchema = z.object(sessionScoped)

export const BridgeInfoSchema = z.object({
  agent_kind: AgentKindFieldSchema,
  agent_version: z.string().max(64).optional(),
  adapter: z.string().min(1).max(64),
  host: z.string().min(1).max(255),
})

export const HelloParamsSchema = z.object({
  protocol: z.array(z.string().max(64)).min(1).max(16),
  bridge: BridgeInfoSchema,
})

export const WelcomeSchema = z.object({
  protocol: z.string(),
  heartbeat_ms: z.number().int().positive(),
  grace_ms: z.number().int().nonnegative(),
  server_time: TimestampSchema,
  min_adapter: z.string().optional(),
})

export const PingResultSchema = z.object({ server_time: TimestampSchema })

const LocalKeySchema = z.string().min(1).max(MAX_LOCAL_KEY_LENGTH)

export const SessionOpenParamsSchema = z.object({
  local_key: LocalKeySchema,
  card: CardInputSchema,
  supersedes: LocalKeySchema.optional(),
})

/**
 * A room in `session.open` / `room.list` results. The spec shows both `{ room, handle }` and
 * `{ room_id, handle, status: "held" }`; `roomIdOf` reads either.
 */
export const RoomEntrySchema = z.object({
  room: z.union([RoomSchema, IdSchema]).optional(),
  room_id: IdSchema.optional(),
  handle: NameSchema,
  status: z.enum(['joined', 'held']).optional(),
  unread: z.number().int().nonnegative().optional(),
})
export type RoomEntry = DeepReadonly<z.output<typeof RoomEntrySchema>>

export function roomIdOf(entry: Pick<RoomEntry, 'room' | 'room_id'>): string | undefined {
  if (entry.room_id) return entry.room_id
  if (typeof entry.room === 'string') return entry.room
  return entry.room?.room_id
}

export const SessionOpenResultSchema = z.object({ session_id: IdSchema, rooms: z.array(RoomEntrySchema) })

export const SessionPatchSchema = z.object({
  model: ModelSchema.optional(),
  summary: SummarySchema.optional(),
  activity: ActivitySchema.optional(),
  accepting: z.boolean().optional(),
  inject: InjectTierSchema.optional(),
  workspace: WorkspaceSchema.optional(),
})

export const SessionUpdateParamsSchema = SessionPatchSchema.extend(sessionScoped)

export const SessionRenameParamsSchema = z
  .object({
    ...sessionScoped,
    title: TitleSchema.optional(),
    handle: NameSchema.optional(),
    room_id: IdSchema.optional(),
  })
  .refine((p) => p.title !== undefined || p.handle !== undefined, 'title or handle is required')
  .refine((p) => p.room_id === undefined || p.handle !== undefined, 'room_id applies to a handle rename')

export const SessionRenameResultSchema = z.object({
  title: z.string().nullish(),
  rooms: z.array(z.object({ room_id: IdSchema, old: NameSchema, new: NameSchema })),
})

export const DashboardLoginResultSchema = z.object({ code: z.string().min(1), url: z.string().min(1) })

export const sessionMethods = {
  hello: { params: HelloParamsSchema, result: WelcomeSchema },
  ping: { params: EmptySchema, result: PingResultSchema },
  'session.open': { params: SessionOpenParamsSchema, result: SessionOpenResultSchema },
  'session.close': { params: SessionScopedSchema, result: EmptySchema },
  'session.update': { params: SessionUpdateParamsSchema, result: EmptySchema },
  'session.rename': { params: SessionRenameParamsSchema, result: SessionRenameResultSchema },
  'dashboard.login': { params: SessionScopedSchema, result: DashboardLoginResultSchema },
  /** §6.4: no response; the hub closes the socket. Bridges send it as a notification. */
  bye: { params: EmptySchema, result: z.undefined() },
} as const
