/** Tool plumbing: specs with zod arguments, JSON Schema for `tools/list`, and output helpers. */
import { createNonce, neutralizeBody, PeersError, toPeersError } from '@agent-peers/protocol'
import { z } from 'zod'
import type { Runtime } from '../runtime'
import type { BridgeSession } from '../session/bridge-session'

export interface ToolCall {
  /** The `session_key` argument, when the model passed one. */
  readonly sessionKey?: string
  /** Codex: `_meta["x-codex-turn-metadata"].thread_id`. */
  readonly threadId?: string
  /** Codex: `_meta["x-codex-turn-metadata"].turn_id`, the turn this call runs in. */
  readonly turnId?: string
  readonly signal: AbortSignal
}

export interface ToolContext {
  readonly rt: Runtime
  readonly call: ToolCall
  readonly tool: string
  /** The calling session (opened on demand); `hub` names a hub the call needs (invite link). */
  session(hub?: string): Promise<BridgeSession>
}

export interface ToolResult {
  readonly text: string
  readonly structured?: Readonly<Record<string, unknown>>
  readonly isError?: boolean
}

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface ToolSpec<S extends z.ZodType> {
  readonly name: string
  readonly description: string
  readonly schema: S
  readonly annotations?: ToolAnnotations
  run(ctx: ToolContext, args: z.output<S>): Promise<ToolResult>
}

/** A tool with its argument type erased, ready for the registry. */
export interface BridgeTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: ToolAnnotations
  invoke(ctx: ToolContext, raw: unknown): Promise<ToolResult>
}

/** Every tool takes an optional `session_key` (ARCHITECTURE §3.1). */
export const SessionKeyField = {
  session_key: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Only when several sessions share this server: the session_key you were given.'),
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
}

export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): BridgeTool {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(spec.schema, { io: 'input' }) as Record<
    string,
    unknown
  >
  return {
    name: spec.name,
    description: spec.description,
    inputSchema,
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
    invoke: async (ctx, raw) => {
      const parsed = spec.schema.safeParse(raw ?? {})
      if (!parsed.success) throw new PeersError('invalid_params', describeIssues(parsed.error))
      return spec.run(ctx, parsed.data)
    },
  }
}

export const ok = (text: string, structured?: Readonly<Record<string, unknown>>): ToolResult =>
  structured ? { text, structured } : { text }

/** Maps any failure to a tool error naming the protocol error code. */
export function errorResult(error: unknown): ToolResult {
  const peers = toPeersError(error)
  const suggestion = typeof peers.data?.suggestion === 'string' ? ` (try @${peers.data.suggestion})` : ''
  return {
    text: `agent-peers error ${peers.code}: ${peers.message}${suggestion}`,
    structured: { error: { code: peers.code, message: peers.message } },
    isError: true,
  }
}

/**
 * Frames remote-controlled free text (titles, summaries, models) in a nonce envelope (PROTOCOL §7.2),
 * so peer text never reads as tool output.
 */
export function frameUntrusted(header: string, lines: readonly string[]): string {
  if (lines.length === 0) return ''
  const nonce = createNonce()
  return [header, `<<<peer-msg ${nonce}>>>`, neutralizeBody(lines.join('\n')), `<<<end ${nonce}>>>`].join(
    '\n',
  )
}

/** `@work` / `work` → `work`. */
export const stripAt = (handle: string): string => handle.trim().replace(/^@/, '')

/** Seconds argument → milliseconds clamped to `[0, capMs]`. */
export function clampSeconds(seconds: number | undefined, fallbackMs: number, capMs: number): number {
  const ms = seconds === undefined ? fallbackMs : Math.round(seconds * 1000)
  return Math.max(0, Math.min(ms, capMs))
}
