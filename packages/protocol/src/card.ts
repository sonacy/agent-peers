/** Session card (PROTOCOL §3) and its building blocks. */
import { z } from 'zod'
import { MAX_LINE_CHARS, MAX_TITLE_CHARS } from './constants'
import { IdSchema, lenientEnum, lineSchema, NameSchema, TimestampSchema } from './schema-util'
import type { DeepReadonly } from './types'

/** Agent products (ARCHITECTURE §1, §6). Unknown kinds from newer bridges are read as `other`. */
export const AGENT_KINDS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'codex-desktop',
  'cursor',
  'cursor-cli',
  'pi',
  'opencode',
  'trae',
  'trae-cli',
  'other',
] as const
export type AgentKind = (typeof AGENT_KINDS)[number]
export const AgentKindSchema = z.enum(AGENT_KINDS)
export const isAgentKind = (value: unknown): value is AgentKind => AgentKindSchema.safeParse(value).success
/** Wire form: any short string, read as an AgentKind (`other` when unknown). */
export const AgentKindFieldSchema = lenientEnum(AGENT_KINDS, 'other')

export const INJECT_TIERS = ['push', 'boundary', 'poll'] as const
export const InjectTierSchema = z.enum(INJECT_TIERS)
export type InjectTier = z.infer<typeof InjectTierSchema>

export const ACTIVITIES = ['idle', 'busy', 'awaiting_input', 'unknown'] as const
export const ActivitySchema = z.enum(ACTIVITIES)
export type Activity = z.infer<typeof ActivitySchema>

export const CONNECTION_STATES = ['online', 'stale', 'offline'] as const
export const ConnectionStateSchema = z.enum(CONNECTION_STATES)
export type ConnectionState = z.infer<typeof ConnectionStateSchema>

/** `workspace.share` (§3): what the bridge reveals about its workspace. */
export const WorkspaceShareSchema = z.enum(['none', 'name', 'full'])
export type WorkspaceShare = z.infer<typeof WorkspaceShareSchema>

const VersionSchema = z.string().max(64)

export const AgentInfoSchema = z.object({
  kind: AgentKindFieldSchema,
  version: VersionSchema.optional(),
  adapter: VersionSchema.optional(),
})
export type AgentInfo = z.infer<typeof AgentInfoSchema>

/** Rejects absolute paths: §3 says they are never sent. */
const looksLikePath = (value: string) => /^(\/|~|\\|[A-Za-z]:[\\/]|file:)/.test(value)

const WorkspaceFieldSchema = lineSchema(200).refine((value) => !looksLikePath(value), {
  message: 'absolute paths are never sent to the hub',
})

export const WorkspaceSchema = z.object({
  name: WorkspaceFieldSchema.refine(
    (value) => !/[\\/]/.test(value),
    'workspace name is a single segment',
  ).optional(),
  git_remote: WorkspaceFieldSchema.optional(),
  branch: WorkspaceFieldSchema.optional(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const TitleSchema = lineSchema(MAX_TITLE_CHARS)
export const SummarySchema = lineSchema(MAX_LINE_CHARS)
export const ModelSchema = lineSchema(MAX_LINE_CHARS)
export const HostSchema = lineSchema(64).refine((value) => value.length > 0, 'host is required')

/** The card fields a bridge supplies on `session.open`; the hub owns the rest. */
export const CardInputSchema = z.object({
  agent: AgentInfoSchema,
  host: HostSchema,
  model: ModelSchema.optional(),
  workspace: WorkspaceSchema.optional(),
  title: TitleSchema.optional(),
  summary: SummarySchema.optional(),
  inject: InjectTierSchema.optional(),
  activity: ActivitySchema.optional(),
  accepting: z.boolean().optional(),
})
export type CardInput = DeepReadonly<z.input<typeof CardInputSchema>>

export const CardRoomSchema = z.object({ room_id: IdSchema, handle: NameSchema })
export type CardRoom = z.infer<typeof CardRoomSchema>

/** §3: the full card as the hub reports it. */
export const SessionCardSchema = z.object({
  session_id: IdSchema,
  member: NameSchema,
  agent: AgentInfoSchema,
  model: z.string().optional(),
  host: z.string(),
  workspace: WorkspaceSchema.optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  inject: InjectTierSchema,
  connection: ConnectionStateSchema,
  activity: ActivitySchema,
  accepting: z.boolean(),
  /** §4: the adapter is older than the hub's `min_adapter`; asks to it fail with `adapter_outdated`. */
  outdated: z.boolean().default(false),
  rooms: z.array(CardRoomSchema).default([]),
  last_seen_at: TimestampSchema,
  last_activity_at: TimestampSchema,
})
export type SessionCard = z.infer<typeof SessionCardSchema>
