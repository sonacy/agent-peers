/**
 * Claude Code hook stdin (hooks reference, verified on 2.1.296): every event carries `session_id`,
 * `cwd` and `hook_event_name`; the event-specific fields used here are optional. Unknown fields are
 * kept (loose) because Claude Code adds fields between versions.
 */
import { MAX_LOCAL_KEY_LENGTH, PeersError } from '@agent-peers/protocol'
import { z } from 'zod'

/** Hook events the `agent-peers hook` command handles for Claude Code, plus the `wait` pseudo-event. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Notification',
  'PermissionRequest',
  'PreToolUse',
  'SessionEnd',
  'wait',
] as const
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

/** Hook stdin is bounded: a tool input or a final message can be large, but not unbounded. */
export const MAX_HOOK_INPUT_BYTES = 2 * 1024 * 1024

export const ClaudeHookInputSchema = z.looseObject({
  session_id: z.string().min(1).max(MAX_LOCAL_KEY_LENGTH),
  hook_event_name: z.string().max(64).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  transcript_path: z.string().max(4096).optional(),
  permission_mode: z.string().max(64).optional(),
  /** SessionStart: startup | resume | clear | compact | fork. */
  source: z.string().min(1).max(32).optional(),
  model: z.string().max(200).optional(),
  prompt: z.string().optional(),
  /** Stop: Claude's final message. StopFailure: the API error text. */
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  tool_name: z.string().min(1).max(256).optional(),
  tool_input: z.unknown().optional(),
  notification_type: z.string().max(64).optional(),
  reason: z.string().max(256).optional(),
  /** Present when Cursor runs an imported Claude Code plugin's hooks (ARCHITECTURE §6.2). */
  cursor_version: z.string().optional(),
})
export type ClaudeHookInput = z.output<typeof ClaudeHookInputSchema>

const EVENT_ALIASES: ReadonlyMap<string, ClaudeHookEvent> = new Map(
  CLAUDE_HOOK_EVENTS.map((event) => [event.toLowerCase(), event] as const),
)

/** Accepts `SessionStart`, `session-start`, `session_start` or `sessionstart`. */
export function normalizeEvent(name: string | undefined): ClaudeHookEvent | undefined {
  if (name === undefined) return undefined
  return EVENT_ALIASES.get(name.replace(/[-_\s]/g, '').toLowerCase())
}

/** Parses hook stdin. Empty input or malformed JSON is `invalid_params` (the hook then no-ops). */
export function parseHookInput(text: string): ClaudeHookInput {
  if (text.trim() === '') throw new PeersError('invalid_params', 'empty hook input on stdin')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeersError('invalid_params', 'hook input on stdin is not JSON')
  }
  const parsed = ClaudeHookInputSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || '(root)'
    throw new PeersError('invalid_params', `hook input is invalid: ${where}: ${issue?.message ?? 'invalid'}`)
  }
  return parsed.data
}

/** Cursor imports Claude Code plugins and runs their hooks: every Claude hook no-ops there. */
export function isCursorHost(
  input: Pick<ClaudeHookInput, 'cursor_version'> | undefined,
  env: EnvVars,
): boolean {
  return Boolean(input?.cursor_version) || Boolean(env.CURSOR_VERSION)
}

export type EnvVars = Readonly<Record<string, string | undefined>>
