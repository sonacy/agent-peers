/**
 * Control-socket operations (ARCHITECTURE §5): JSON-RPC 2.0 requests, one per line, from hook
 * processes and the CLI to a bridge. Every op carries the `local_key` from the agent's hook stdin.
 */
import { ActivitySchema, AgentKindFieldSchema, MAX_LOCAL_KEY_LENGTH } from '@agent-peers/protocol'
import { z } from 'zod'

export const CONTROL_OPS = [
  'register',
  'activity',
  'take',
  'wait',
  'turn_end',
  'end',
  'gate',
  'permission',
  'autojoin',
] as const
export type ControlOp = (typeof CONTROL_OPS)[number]

/** One line is at most 1 MiB (an envelope is ≤ 64 KiB; tool inputs can be larger). */
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024
/** `wait` long-polls are capped below every client's hook timeout. */
export const MAX_WAIT_MS = 10 * 60 * 1000

const LocalKeySchema = z.string().min(1).max(MAX_LOCAL_KEY_LENGTH)
const keyed = { local_key: LocalKeySchema }
const MaxCharsSchema = z.number().int().min(256).max(1_048_576)

export const RegisterParamsSchema = z.object({
  ...keyed,
  /** SessionStart source (`startup`, `resume`, `clear`, `compact`, …) or `implicit` / `mcp`. */
  source: z.string().min(1).max(32),
  supersedes: LocalKeySchema.optional(),
  cwd: z.string().min(1).max(4096).optional(),
  /** The agent's model from the hook input (Claude Code SessionStart `model`), shown on the card. */
  model: z.string().min(1).max(200).optional(),
})
export const ActivityParamsSchema = z.object({
  ...keyed,
  state: ActivitySchema,
  /** UserPromptSubmit: a new turn starts (a peer turn left open by an interrupted turn is closed). */
  turn_start: z.boolean().optional(),
  /**
   * UserPromptSubmit: ask ids of agent-peers envelopes the prompt itself carries. Claude Code submits
   * an asyncRewake wake as a queued prompt, which fires UserPromptSubmit: that prompt IS the peer
   * turn, not a new turn that should close it.
   */
  carries: z.array(z.string().min(1).max(64)).max(16).optional(),
})
export const TakeParamsSchema = z.object({ ...keyed, max_chars: MaxCharsSchema })
export const WaitParamsSchema = z.object({
  ...keyed,
  timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS),
  max_chars: MaxCharsSchema.optional(),
})
export const TurnEndParamsSchema = z.object({
  ...keyed,
  inject_ids: z.array(z.string().min(1).max(128)).max(256).default([]),
  last_message: z
    .string()
    .max(256 * 1024)
    .optional(),
})
export const EndParamsSchema = z.object(keyed)
export const GateParamsSchema = z.object({
  ...keyed,
  tool: z.string().min(1).max(256),
  input: z.unknown(),
  cwd: z.string().min(1).max(4096).optional(),
})
export const PermissionParamsSchema = z.object({
  ...keyed,
  tool: z.string().min(1).max(256),
  input: z.unknown().optional(),
})
export const AutojoinParamsSchema = z.object({
  ...keyed,
  agent_kind: AgentKindFieldSchema,
  /** Realpath of the workspace (local only). */
  workspace: z.string().min(1).max(4096),
})

export const RegisterResultSchema = z.object({
  /** Context for the model (handle, rooms, session_key hint), when the adapter can inject it. */
  context: z.string().optional(),
})
export const EmptyResultSchema = z.object({})
export const InjectedSchema = z.object({ envelope: z.string(), inject_id: z.string().min(1) })
export const InjectedOrNullSchema = InjectedSchema.nullable()
export const TurnEndResultSchema = z.object({
  /** Continue the agent once with this text (PROTOCOL §7.3 step 1). */
  reminder: z.string().optional(),
})
export const GateResultSchema = z.object({ decision: z.enum(['allow', 'deny']), reason: z.string() })
export const PermissionResultSchema = z.object({
  allow: z.literal(true).optional(),
  reason: z.string().optional(),
})
export const AutojoinResultSchema = z.object({ accepted: z.boolean() })

export const OP_SCHEMAS = {
  register: { params: RegisterParamsSchema, result: RegisterResultSchema },
  activity: { params: ActivityParamsSchema, result: EmptyResultSchema },
  take: { params: TakeParamsSchema, result: InjectedOrNullSchema },
  wait: { params: WaitParamsSchema, result: InjectedOrNullSchema },
  turn_end: { params: TurnEndParamsSchema, result: TurnEndResultSchema },
  end: { params: EndParamsSchema, result: EmptyResultSchema },
  gate: { params: GateParamsSchema, result: GateResultSchema },
  permission: { params: PermissionParamsSchema, result: PermissionResultSchema },
  autojoin: { params: AutojoinParamsSchema, result: AutojoinResultSchema },
} as const satisfies Record<ControlOp, { params: z.ZodType; result: z.ZodType }>

export type ParamsOf<Op extends ControlOp> = z.output<(typeof OP_SCHEMAS)[Op]['params']>
export type ParamsInputOf<Op extends ControlOp> = z.input<(typeof OP_SCHEMAS)[Op]['params']>
export type ResultOf<Op extends ControlOp> = z.output<(typeof OP_SCHEMAS)[Op]['result']>
export type Injected = z.output<typeof InjectedSchema>

export const isControlOp = (value: string): value is ControlOp =>
  (CONTROL_OPS as readonly string[]).includes(value)

/** Per-request context the server passes to the handler. */
export interface ControlContext {
  /** Aborted when the client disconnects, the request times out, or a newer `wait` supersedes it. */
  readonly signal: AbortSignal
}

/**
 * What a bridge implements. The server validates params and results, enforces timeouts and the
 * single-waiter rule, and calls `undelivered` when an envelope could not be written back.
 */
export interface ControlHandler {
  register(params: ParamsOf<'register'>, ctx: ControlContext): Promise<ResultOf<'register'>>
  activity(params: ParamsOf<'activity'>, ctx: ControlContext): Promise<ResultOf<'activity'>>
  take(params: ParamsOf<'take'>, ctx: ControlContext): Promise<ResultOf<'take'>>
  wait(params: ParamsOf<'wait'>, ctx: ControlContext): Promise<ResultOf<'wait'>>
  turn_end(params: ParamsOf<'turn_end'>, ctx: ControlContext): Promise<ResultOf<'turn_end'>>
  end(params: ParamsOf<'end'>, ctx: ControlContext): Promise<ResultOf<'end'>>
  gate(params: ParamsOf<'gate'>, ctx: ControlContext): Promise<ResultOf<'gate'>>
  permission(params: ParamsOf<'permission'>, ctx: ControlContext): Promise<ResultOf<'permission'>>
  autojoin(params: ParamsOf<'autojoin'>, ctx: ControlContext): Promise<ResultOf<'autojoin'>>
  /** An envelope from take/wait was produced but the client was gone: re-queue it. */
  undelivered?(localKey: string, injected: Injected): void
  /** An envelope from take/wait was written to the client. */
  delivered?(localKey: string, op: 'take' | 'wait', injected: Injected): void
}
