/**
 * Local file schemas: config.json (ARCHITECTURE §4 "Configure", §8), credentials.json (PROTOCOL §8)
 * and autojoin.json (ONBOARDING §3 step 6). Unknown top-level config keys are kept, so an older
 * bridge never drops a newer installer's settings on write.
 */
import { AgentKindFieldSchema, NameSchema, WorkspaceShareSchema } from '@agent-peers/protocol'
import { z } from 'zod'

/** ARCHITECTURE §8 default: 10 peer turns per hour per session. */
export const DEFAULT_PEER_TURNS_PER_HOUR = 10
/** ARCHITECTURE §3.1: inline `peers_ask` wait, below every client's tool timeout. */
export const DEFAULT_INLINE_WAIT_MS = 45_000
/** Asks replayed after being queued longer than this go to the inbox, not into a turn (ARCHITECTURE §8). */
export const DEFAULT_MAX_REPLAY_AGE_MS = 6 * 60 * 60 * 1000

/** Read-only tools a peer turn may use (ARCHITECTURE §8). Names are canonical (gate/tools.ts). */
export const DEFAULT_PEER_TURN_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS']

/** Read-only shell commands (first words) a peer turn may run, inside the workspace root. */
export const DEFAULT_PEER_TURN_COMMANDS: readonly string[] = [
  'git log',
  'git diff',
  'git show',
  'git status',
  'rg',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
]

/** ONBOARDING §5: secrets a peer turn may never read, even inside the workspace. */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  'id_*',
  '.npmrc',
  '.netrc',
  'credentials*',
  '~/.ssh',
  '~/.aws',
  '~/.config/gh',
  '~/.agent-peers',
]

export const ReplyFallbackSchema = z.enum(['auto', 'nudge'])
export type ReplyFallback = z.infer<typeof ReplyFallbackSchema>

const ToolListSchema = z.array(z.string().min(1).max(128)).max(256)

export const PeerTurnConfigSchema = z.object({
  allow_tools: ToolListSchema.default([...DEFAULT_PEER_TURN_TOOLS]),
  allow_commands: ToolListSchema.default([...DEFAULT_PEER_TURN_COMMANDS]),
  deny_globs: z
    .array(z.string().min(1).max(256))
    .max(256)
    .default([...DEFAULT_DENY_GLOBS]),
  /** Opt-in write tools per room id (ARCHITECTURE §8: `meta.mode` never widens the allowlist). */
  write_allowlist: z.record(z.string().min(1).max(64), ToolListSchema).default({}),
})
export type PeerTurnConfig = z.infer<typeof PeerTurnConfigSchema>

export const InjectionConfigSchema = z.object({
  peer_turns_per_hour: z.number().int().min(0).max(1000).default(DEFAULT_PEER_TURNS_PER_HOUR),
  max_inject_chars: z.number().int().min(256).max(1_048_576).optional(),
  max_replay_age_ms: z.number().int().nonnegative().default(DEFAULT_MAX_REPLAY_AGE_MS),
})
export type InjectionConfig = z.infer<typeof InjectionConfigSchema>

export const LocalConfigSchema = z.looseObject({
  default_hub: z.url({ protocol: /^(https?|wss?)$/ }).optional(),
  handle: NameSchema.optional(),
  workspace: z.object({ share: WorkspaceShareSchema.default('name') }).prefault({}),
  peer_turn: PeerTurnConfigSchema.prefault({}),
  reply_fallback: ReplyFallbackSchema.default('auto'),
  injection: InjectionConfigSchema.prefault({}),
  inline_wait_ms: z.number().int().min(1000).max(170_000).default(DEFAULT_INLINE_WAIT_MS),
})
export type LocalConfig = z.infer<typeof LocalConfigSchema>
export type LocalConfigInput = z.input<typeof LocalConfigSchema>

export const defaultLocalConfig = (): LocalConfig => LocalConfigSchema.parse({})

/** Normalizes a hub URL or origin to its origin (`https://hub.example.com`). */
export function hubOrigin(hub: string): string {
  const url = new URL(hub)
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  return `${protocol}//${url.host}`
}

const OriginSchema = z.string().refine(
  (value) => {
    try {
      return hubOrigin(value) === value && /^https?:/.test(value)
    } catch {
      return false
    }
  },
  { message: 'keys must be hub origins like https://hub.example.com' },
)

export const CredentialSchema = z.object({
  member_token: z.string().min(1).max(512),
  member: NameSchema.optional(),
  saved_at: z.number().int().nonnegative().optional(),
})
export type Credential = z.infer<typeof CredentialSchema>

export const CredentialsSchema = z.object({
  hubs: z.record(OriginSchema, CredentialSchema).default({}),
})
export type Credentials = z.infer<typeof CredentialsSchema>

export const AutojoinScopeSchema = z.enum(['workspace', 'session', 'none'])
export type AutojoinScope = z.infer<typeof AutojoinScopeSchema>

export const AutojoinEntrySchema = z.object({
  hub: OriginSchema,
  room_id: z.string().min(1).max(64),
  handle: NameSchema,
  agent: AgentKindFieldSchema,
  /** Realpath of the workspace (local only; never sent to the hub). */
  workspace: z.string().min(1).max(4096),
  local_key: z.string().min(1).max(256).optional(),
  scope: AutojoinScopeSchema,
})
export type AutojoinEntry = z.infer<typeof AutojoinEntrySchema>

export const AutojoinFileSchema = z.array(AutojoinEntrySchema).max(1000)
