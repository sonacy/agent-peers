/**
 * `agent-peers hook <event> --agent claude-code`: parse the hook's stdin, talk to the bridge over
 * the control socket and print what Claude Code expects. A hook never blocks the agent: when the
 * bridge is unreachable or the input is unusable it logs a warning and prints `{}` with exit 0.
 * The one exception is the PreToolUse gate, which fails closed when a peer turn may be running.
 */
import { type EnvLike, type ProcessTree, peersPaths, resolvePeersHome } from '@agent-peers/core'
import { toPeersError } from '@agent-peers/protocol'
import {
  EVENT_HANDLERS,
  type HookClock,
  type HookContext,
  preToolUseFallback,
  systemHookClock,
} from './events'
import {
  type ClaudeHookEvent,
  type ClaudeHookInput,
  isCursorHost,
  normalizeEvent,
  parseHookInput,
} from './input'
import { fileLogger, type HookLogger, hookLogPath } from './log'
import { type HookResult, jsonResult } from './output'
import { HookState } from './state'
import { type BridgeCaller, discoveryCaller } from './transport'
import { runWaiter, type WaiterOptions } from './waiter'

/**
 * The waiter's budget when `--timeout` is not given: the adapter's waiter timeout (one day). If the
 * agent's real timeout is shorter it kills the waiter mid-poll, which is safe: the bridge re-queues
 * an envelope whose reader went away.
 */
export const DEFAULT_WAIT_TIMEOUT_S = 86_400
/** The waiter exits this long before Claude Code would kill it. */
export const WAIT_EXIT_MARGIN_MS = 5000

export interface ClaudeHookDeps {
  readonly caller: BridgeCaller
  readonly state: HookState
  readonly log: HookLogger
  readonly clock?: HookClock
}

export interface ClaudeHookRequest {
  /** The `<event>` argument: `session-start`, `SessionStart`, …, or `wait`. */
  readonly event: string
  /** `--wait`: run as the asyncRewake waiter whatever the event. */
  readonly wait?: boolean
  /** Raw hook stdin. */
  readonly stdin: string
  readonly env: EnvLike
  /** Waiter tuning; `budgetMs` defaults to the hook timeout minus a margin. */
  readonly waiter?: Partial<WaiterOptions>
  /** `--timeout <s>`: the hook's configured timeout. */
  readonly timeoutSeconds?: number
}

/** Production wiring: the agent-peers home from the environment, discovery by ancestor PID. */
export function defaultClaudeHookDeps(
  env: EnvLike,
  options: {
    readonly pid?: number
    readonly tree?: ProcessTree
    readonly stderr?: (line: string) => void
    /**
     * Wait for a bridge that is still starting. Only SessionStart and the waiter race the MCP
     * server's startup; other hooks fail fast so a missing bridge never slows down tool calls.
     */
    readonly discoverWaitMs?: number
  } = {},
): ClaudeHookDeps {
  const paths = peersPaths(resolvePeersHome(env))
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
  return {
    caller: discoveryCaller({
      runDir: paths.run,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.tree === undefined ? {} : { tree: options.tree }),
      discoverWaitMs: options.discoverWaitMs ?? 0,
    }),
    state: new HookState(paths.run),
    log: fileLogger(hookLogPath(paths.root), stderr),
  }
}

function waiterOptions(request: ClaudeHookRequest): WaiterOptions {
  const seconds = request.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_S
  const budgetMs = Math.max(0, seconds * 1000 - WAIT_EXIT_MARGIN_MS)
  return { budgetMs, ...request.waiter }
}

/** Hooks that can fire before the bridge has published itself (Claude starts both together). */
export function racesBridgeStartup(event: string, wait: boolean | undefined): boolean {
  if (wait === true) return true
  const normalized = normalizeEvent(event)
  return normalized === 'wait' || normalized === 'SessionStart'
}

async function dispatch(
  ctx: HookContext,
  event: ClaudeHookEvent,
  input: ClaudeHookInput,
  request: ClaudeHookRequest,
): Promise<HookResult> {
  if (event === 'wait' || request.wait === true) return runWaiter(ctx, input, waiterOptions(request))
  return jsonResult(await EVENT_HANDLERS[event](ctx, input))
}

export async function runClaudeHook(request: ClaudeHookRequest, deps: ClaudeHookDeps): Promise<HookResult> {
  const ctx: HookContext = { ...deps, clock: deps.clock ?? systemHookClock }
  let input: ClaudeHookInput
  try {
    input = parseHookInput(request.stdin)
  } catch (error) {
    await ctx.log(`hook ${request.event}: ${toPeersError(error).message}`)
    return jsonResult()
  }
  if (isCursorHost(input, request.env)) return jsonResult()
  const event = normalizeEvent(request.event) ?? normalizeEvent(input.hook_event_name)
  if (event === undefined) {
    await ctx.log(`hook ${request.event}: unknown Claude Code hook event, ignored`)
    return jsonResult()
  }
  try {
    return await dispatch(ctx, event, input, request)
  } catch (error) {
    const peersError = toPeersError(error)
    await ctx.log(`hook ${event} (${input.session_id}): ${peersError.code}: ${peersError.message}`)
    if (event === 'PreToolUse' && request.wait !== true)
      return jsonResult(await preToolUseFallback(ctx, input, peersError.code))
    return jsonResult()
  }
}
