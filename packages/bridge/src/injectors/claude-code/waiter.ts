/**
 * The asyncRewake waiter (ARCHITECTURE §6.1–§6.2): an async hook armed on SessionStart, Stop and
 * StopFailure that long-polls `wait`. An envelope is printed to stderr with exit 2, which wakes an
 * idle Claude Code session (the text arrives as a system reminder). A `null` before the poll's
 * deadline means a newer waiter took over this `local_key` (ARCHITECTURE §5): exit 0. A `null` at
 * the deadline re-arms until the hook's own timeout budget is spent.
 */
import { MAX_WAIT_MS } from '@agent-peers/core'
import { isPeersError, toPeersError } from '@agent-peers/protocol'
import { type HookContext, MAX_ENVELOPE_CHARS, registerSession } from './events'
import type { ClaudeHookInput } from './input'
import { type HookResult, jsonResult, wakeResult } from './output'

export interface WaiterOptions {
  /** Time this hook may run (Claude Code enforces the hook `timeout` for asyncRewake). */
  readonly budgetMs: number
  /** How long the bridge may stay unreachable (startup, plugin reload) before the waiter gives up. */
  readonly reconnectWindowMs?: number
  /** Pause between attempts to reach the bridge. */
  readonly retryMs?: number
  /** A `null` this much before the poll deadline counts as "superseded". */
  readonly earlySlackMs?: number
}

export const DEFAULT_RECONNECT_WINDOW_MS = 60_000
const DEFAULT_RETRY_MS = 500
const DEFAULT_EARLY_SLACK_MS = 1000
/** `activity busy` after a wake confirms the hand-out; it must not delay the wake much. */
const CONFIRM_TIMEOUT_MS = 1500

/** Errors that mean "no bridge to talk to right now". */
const UNREACHABLE_CODES = ['not_connected', 'disconnected', 'timeout'] as const

const isUnreachable = (error: unknown): boolean => UNREACHABLE_CODES.some((code) => isPeersError(error, code))

/**
 * Any failed poll (no bridge, or a bridge-side error such as a hub hiccup) is retried within the
 * reconnect window: the waiter is the only thing that can wake this session until the next Stop.
 */
type PollOutcome =
  | { readonly kind: 'envelope'; readonly envelope: string; readonly injectId: string }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'idle'; readonly bridgePid: number }
  | { readonly kind: 'failed'; readonly error: unknown }

async function poll(
  ctx: HookContext,
  input: ClaudeHookInput,
  sliceMs: number,
  slackMs: number,
): Promise<PollOutcome> {
  const started = ctx.clock.now()
  try {
    const { bridgePid, result } = await ctx.caller.call('wait', {
      local_key: input.session_id,
      timeout_ms: sliceMs,
      max_chars: MAX_ENVELOPE_CHARS,
    })
    if (result !== null) return { kind: 'envelope', envelope: result.envelope, injectId: result.inject_id }
    const early = ctx.clock.now() - started < sliceMs - slackMs
    return early ? { kind: 'superseded' } : { kind: 'idle', bridgePid }
  } catch (error) {
    return { kind: 'failed', error }
  }
}

/**
 * After /clear or /resume the old conversation's waiter may outlive it; re-arming would re-open the
 * replaced session, so a waiter stops once its bridge runs another conversation.
 */
async function replaced(ctx: HookContext, input: ClaudeHookInput, bridgePid: number): Promise<boolean> {
  const current = await ctx.state.currentKey(bridgePid)
  return current !== undefined && current !== input.session_id
}

/** Records and confirms a hand-out; best effort, the wake matters more. */
async function confirmWake(ctx: HookContext, input: ClaudeHookInput, injectId: string): Promise<void> {
  try {
    await ctx.state.rememberInjectId(input.session_id, injectId)
    await ctx.caller.call(
      'activity',
      { local_key: input.session_id, state: 'busy' },
      { timeoutMs: CONFIRM_TIMEOUT_MS },
    )
  } catch (error) {
    await ctx.log(`waiter: confirming ${injectId} failed: ${String(error)}`)
  }
}

/**
 * SessionStart waiters register first, so the session never opens without its `supersedes`. A
 * failure is logged, not fatal: the poll loop retries, and `wait` registers implicitly.
 */
async function registerIfStarting(ctx: HookContext, input: ClaudeHookInput): Promise<void> {
  if (input.hook_event_name !== 'SessionStart') return
  try {
    await registerSession(ctx, input)
  } catch (error) {
    if (!isUnreachable(error)) await ctx.log(`waiter: register failed: ${toPeersError(error).message}`)
  }
}

export async function runWaiter(
  ctx: HookContext,
  input: ClaudeHookInput,
  options: WaiterOptions,
): Promise<HookResult> {
  const reconnectWindow = options.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const slackMs = options.earlySlackMs ?? DEFAULT_EARLY_SLACK_MS
  const deadline = ctx.clock.now() + options.budgetMs
  await registerIfStarting(ctx, input)
  let reachableAt = ctx.clock.now()
  for (;;) {
    const left = deadline - ctx.clock.now()
    if (left <= 0) return jsonResult()
    const outcome = await poll(ctx, input, Math.min(left, MAX_WAIT_MS), slackMs)
    if (outcome.kind === 'envelope') {
      await confirmWake(ctx, input, outcome.injectId)
      return wakeResult(outcome.envelope)
    }
    if (outcome.kind === 'superseded') return jsonResult()
    if (outcome.kind === 'idle') {
      if (await replaced(ctx, input, outcome.bridgePid)) return jsonResult()
      reachableAt = ctx.clock.now()
      continue
    }
    if (ctx.clock.now() - reachableAt >= reconnectWindow) {
      await ctx.log(
        `waiter: bridge unreachable or failing, giving up: ${toPeersError(outcome.error).message}`,
      )
      return jsonResult()
    }
    await ctx.clock.sleep(Math.min(retryMs, Math.max(0, deadline - ctx.clock.now())))
  }
}
