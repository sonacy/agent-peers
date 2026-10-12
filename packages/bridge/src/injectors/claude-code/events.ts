/**
 * Claude Code lifecycle hooks mapped onto control-socket ops (ARCHITECTURE §5, §6.2, §8):
 * SessionStart → register, UserPromptSubmit → busy + take, Stop → turn_end (+ the one nudge),
 * StopFailure / Notification → activity, PermissionRequest → permission, PreToolUse → gate,
 * SessionEnd → end. The asyncRewake waiter lives in waiter.ts.
 */
import type { Activity } from '@agent-peers/protocol'
import { PeersError } from '@agent-peers/protocol'
import type { ClaudeHookInput } from './input'
import { additionalContext, allowPermission, blockStop, denyTool, EMPTY_JSON, type HookJson } from './output'
import type { HookState } from './state'
import type { BridgeCaller } from './transport'

export interface HookClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemHookClock: HookClock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) }

export interface HookContext {
  readonly caller: BridgeCaller
  readonly state: HookState
  readonly log: (line: string) => Promise<void>
  readonly clock: HookClock
}

/** Claude Code caps hook output at 10 000 chars; envelopes share this budget (PROTOCOL §7.2). */
export const PROMPT_CONTEXT_BUDGET = 9000
/** Envelope budget of one take; the bridge caps it at the surface's `max_inject_chars` too. */
export const MAX_ENVELOPE_CHARS = 8000
/** Another envelope is taken only while at least this much budget is left. */
const MIN_EXTRA_ENVELOPE_CHARS = 2000
const MAX_ENVELOPES_PER_PROMPT = 5
const ENVELOPE_SEPARATOR = '\n\n'
/** `turn_end.last_message` limit (control op schema). */
const MAX_LAST_MESSAGE_CHARS = 256 * 1024
/** SessionEnd hooks share a 1.5 s budget. */
const SESSION_END_TIMEOUT_MS = 1000

const keyed = (input: ClaudeHookInput) => ({ local_key: input.session_id })

/** Bookkeeping must not cost the agent its hook output: a failure is logged, never thrown. */
async function bestEffort<T>(ctx: HookContext, what: string, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (error) {
    await ctx.log(`${what} failed: ${String(error)}`)
    return undefined
  }
}

/** register, superseding the conversation this Claude Code process ran before (/clear, /resume, fork). */
export async function registerSession(ctx: HookContext, input: ClaudeHookInput): Promise<string | undefined> {
  const source = input.source ?? 'startup'
  const bridgePid = await ctx.caller.locate(input.session_id)
  if (bridgePid === undefined)
    throw new PeersError('not_connected', 'no agent-peers bridge found for this Claude Code process')
  const supersedes = await bestEffort(ctx, 'hook state', () =>
    ctx.state.noteSessionStart(bridgePid, input.session_id, source),
  )
  const { result } = await ctx.caller.call('register', {
    ...keyed(input),
    source,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  })
  return result.context
}

async function sessionStart(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  return additionalContext('SessionStart', await registerSession(ctx, input))
}

/** One `take`; after the first, a failure ends the loop instead of losing what was already taken. */
async function takeOne(ctx: HookContext, input: ClaudeHookInput, maxChars: number, first: boolean) {
  try {
    return (await ctx.caller.call('take', { ...keyed(input), max_chars: maxChars })).result
  } catch (error) {
    if (first) throw error
    await ctx.log(`take failed after earlier envelopes; printing those: ${String(error)}`)
    return null
  }
}

/** Takes envelopes until the hook-output budget is used up. */
async function takeEnvelopes(ctx: HookContext, input: ClaudeHookInput): Promise<readonly string[]> {
  const taken: string[] = []
  let left = PROMPT_CONTEXT_BUDGET
  while (taken.length < MAX_ENVELOPES_PER_PROMPT) {
    const maxChars = Math.min(MAX_ENVELOPE_CHARS, left)
    if (taken.length > 0 && maxChars < MIN_EXTRA_ENVELOPE_CHARS) break
    const result = await takeOne(ctx, input, maxChars, taken.length === 0)
    if (result === null) break
    taken.push(result.envelope)
    left -= result.envelope.length + ENVELOPE_SEPARATOR.length
    await bestEffort(ctx, 'hook state', () => ctx.state.rememberInjectId(input.session_id, result.inject_id))
  }
  return taken
}

/** UserPromptSubmit: a new turn (closing a peer turn an interrupted one left open), then `take`. */
async function promptSubmit(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  await bestEffort(ctx, 'activity', () =>
    ctx.caller.call('activity', { ...keyed(input), state: 'busy', turn_start: true }),
  )
  const envelopes = await takeEnvelopes(ctx, input)
  return additionalContext('UserPromptSubmit', envelopes.join(ENVELOPE_SEPARATOR))
}

async function stop(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  const injectIds =
    (await bestEffort(ctx, 'hook state', () => ctx.state.takeInjectIds(input.session_id))) ?? []
  const last = input.last_assistant_message?.slice(0, MAX_LAST_MESSAGE_CHARS)
  const { result } = await ctx.caller.call('turn_end', {
    ...keyed(input),
    inject_ids: [...injectIds],
    ...(last === undefined ? {} : { last_message: last }),
  })
  return result.reminder === undefined ? EMPTY_JSON : blockStop(result.reminder)
}

/** StopFailure output is ignored by Claude Code: report idle and keep the peer turn for the next Stop. */
async function stopFailure(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  await ctx.caller.call('activity', { ...keyed(input), state: 'idle' })
  return EMPTY_JSON
}

const notificationActivity = (type: string | undefined): Activity =>
  type === 'idle_prompt' ? 'idle' : 'awaiting_input'

async function notification(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  await ctx.caller.call('activity', { ...keyed(input), state: notificationActivity(input.notification_type) })
  return EMPTY_JSON
}

async function permissionRequest(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  if (input.tool_name === undefined) return EMPTY_JSON
  const { result } = await ctx.caller.call('permission', {
    ...keyed(input),
    tool: input.tool_name,
    input: input.tool_input,
  })
  return result.allow === true ? allowPermission() : EMPTY_JSON
}

/** Tool inputs above this are sent without their bulky fields (a control line is capped at 1 MiB). */
export const MAX_GATE_INPUT_CHARS = 512 * 1024
const MAX_KEPT_FIELD_CHARS = 16 * 1024

/**
 * The gate needs paths and commands, not a Write's megabytes of content: an oversized input keeps
 * only its short fields, so the call is still checked (a dropped `command` is denied in a peer turn).
 */
export function gateInput(toolInput: unknown): unknown {
  let size: number
  try {
    size = JSON.stringify(toolInput ?? null).length
  } catch {
    return {}
  }
  if (size <= MAX_GATE_INPUT_CHARS || typeof toolInput !== 'object' || toolInput === null) return toolInput
  return Object.fromEntries(
    Object.entries(toolInput as Record<string, unknown>).filter(
      ([, value]) => (JSON.stringify(value ?? null) ?? '').length <= MAX_KEPT_FIELD_CHARS,
    ),
  )
}

async function preToolUse(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  if (input.tool_name === undefined) return EMPTY_JSON
  const { result } = await ctx.caller.call('gate', {
    ...keyed(input),
    tool: input.tool_name,
    input: gateInput(input.tool_input),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  })
  return result.decision === 'deny' ? denyTool(result.reason) : EMPTY_JSON
}

/** Errors that only mean "no bridge serves this process right now". */
const NO_BRIDGE_CODES: ReadonlySet<string> = new Set(['not_connected', 'disconnected'])

/**
 * The PreToolUse gate fails closed: when the gate call fails, the tool is denied if envelopes were
 * handed to this session since its last Stop (a peer turn may be running), or if the bridge was
 * reached but could not answer (timeout, internal error). Only "no bridge at all" with no envelope
 * handed out lets the tool run.
 */
export async function preToolUseFallback(
  ctx: HookContext,
  input: ClaudeHookInput,
  code: string,
): Promise<HookJson> {
  const pending = (await bestEffort(ctx, 'hook state', () => ctx.state.readInjectIds(input.session_id))) ?? []
  if (pending.length === 0 && NO_BRIDGE_CODES.has(code)) return EMPTY_JSON
  return denyTool(`agent-peers: the peer-turn gate could not check this tool call (${code}); try again`)
}

async function sessionEnd(ctx: HookContext, input: ClaudeHookInput): Promise<HookJson> {
  await ctx.caller.call('end', keyed(input), { timeoutMs: SESSION_END_TIMEOUT_MS })
  return EMPTY_JSON
}

export type EventHandler = (ctx: HookContext, input: ClaudeHookInput) => Promise<HookJson>

export const EVENT_HANDLERS = {
  SessionStart: sessionStart,
  UserPromptSubmit: promptSubmit,
  Stop: stop,
  StopFailure: stopFailure,
  Notification: notification,
  PermissionRequest: permissionRequest,
  PreToolUse: preToolUse,
  SessionEnd: sessionEnd,
} as const satisfies Record<string, EventHandler>
