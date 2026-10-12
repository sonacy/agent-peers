/**
 * The hidden `peers_hook` tool (ARCHITECTURE §6.1 "Hooks → bridge"): Codex `mcp_tool` hook handlers
 * call it with templated event fields. It applies the same semantics as the control-socket ops and
 * returns Codex hook JSON (`hookSpecificOutput`, `decision: "block"`).
 *
 * The model can call this tool too. During a peer turn, the turn-scoped events (UserPromptSubmit,
 * Stop) must carry the Codex `turn_id` the peer turn is bound to (the model never sees turn ids), so
 * a prompt-injected peer cannot end its own turn and lift the gate; PreToolUse fails closed.
 */
import { toPeersError } from '@agent-peers/protocol'
import { z } from 'zod'
import { BridgeControl, registerContext } from '../control/handler'
import type { BridgeSession } from '../session/bridge-session'
import { type BridgeTool, defineTool, ok, type ToolContext } from './define'

/** Template fields Codex could not fill arrive verbatim (`${turn_id}`): treat them as absent. */
export function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length === 0 || /^\$\{[^}]*\}$/.test(text) ? undefined : text
}

/** `tool_input` may arrive as an object or as its JSON text. */
export function toolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const HookArgs = z.looseObject({
  hook_event_name: z.string().max(64).optional(),
  session_id: z.string().max(256).optional(),
  turn_id: z.string().max(256).optional(),
  cwd: z.string().max(4096).optional(),
  model: z.string().max(200).optional(),
  source: z.string().max(64).optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.union([z.boolean(), z.string()]).optional(),
  tool_name: z.string().max(256).optional(),
  tool_use_id: z.string().max(256).optional(),
  tool_input: z.unknown().optional(),
  agent: z.string().max(64).optional(),
})
type HookArgs = z.output<typeof HookArgs>

export type HookOutput = Readonly<Record<string, unknown>>

const output = (value: HookOutput) => ok(JSON.stringify(value), value)

interface Identity {
  readonly localKey: string
  readonly cwd?: string
  readonly model?: string
}

interface HookCall {
  readonly ctx: ToolContext
  readonly control: BridgeControl
  readonly identity: Identity
  readonly args: HookArgs
}

const denyTool = (reason: string): HookOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
})

async function sessionStart({ control, identity, args }: HookCall): Promise<HookOutput> {
  const session = await control.session(identity, clean(args.source) ?? 'startup')
  const context = await registerContext(session)
  return context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {}
}

/**
 * Codex stamps every tools/call with the running turn's id (`_meta["x-codex-turn-metadata"]`). A
 * hook names its event's turn in `turn_id`; a model calling this tool would have to guess it.
 */
function consistentTurn(call: HookCall): boolean {
  const meta = call.ctx.call.turnId
  return meta === undefined || meta === clean(call.args.turn_id)
}

/**
 * A turn-scoped event during a peer turn must come from the agent turn the peer turn is bound to.
 * Before a binding exists the first event that names a turn binds it. Once the hooks are known to
 * fill `turn_id`, an event without one is refused.
 */
function fromBoundTurn(call: HookCall, session: BridgeSession): boolean {
  if (!consistentTurn(call)) return false
  if (session.queue.peerTurn === null) return true
  const turnId = clean(call.args.turn_id)
  if (turnId === undefined) return !session.turns.hooksNameTurns
  const bound = session.turns.turnId
  if (bound === undefined) session.turns.bind(turnId)
  return bound === undefined || bound === turnId
}

function refuse(call: HookCall, event: string): HookOutput {
  call.ctx.rt.log(
    `peers_hook ${event} for ${call.identity.localKey} refused: it does not carry the turn id of the open peer turn`,
  )
  return {}
}

async function promptSubmit(call: HookCall): Promise<HookOutput> {
  const session = await call.control.session(call.identity)
  const turnId = clean(call.args.turn_id)
  session.turns.noteTurnId(turnId)
  // A peer turn left open by an earlier Codex turn (Esc) is abandoned by a new prompt, which always
  // names its turn; a call that names none, or not the turn it runs in, is not that prompt.
  const unnamed = turnId === undefined && session.turns.hooksNameTurns
  if (!consistentTurn(call) || (session.queue.peerTurn !== null && unnamed))
    return refuse(call, 'UserPromptSubmit')
  await session.turns.begin(turnId)
  const out = await session.handOut('take', call.ctx.rt.descriptor.maxInjectChars, { inline: true })
  session.turns.bind(turnId)
  return out
    ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.envelope } }
    : {}
}

async function stop(call: HookCall): Promise<HookOutput> {
  const session = await call.control.session(call.identity)
  session.turns.noteTurnId(clean(call.args.turn_id))
  if (!fromBoundTurn(call, session)) return refuse(call, 'Stop')
  const last = clean(call.args.last_assistant_message)
  const outcome = await session.turns.end(last === undefined ? {} : { last_message: last })
  if (outcome.kind === 'nudge') return { decision: 'block', reason: outcome.reminder }
  // Held envelopes continue the thread as a new prompt (Stop `decision: block`, ARCHITECTURE §6.2).
  const out = await session.handOut('push', call.ctx.rt.descriptor.maxInjectChars, { inline: true })
  if (out) {
    session.turns.expectCarrier()
    session.turns.bind(clean(call.args.turn_id))
    return { decision: 'block', reason: out.envelope }
  }
  session.setActivity('idle')
  return {}
}

async function preToolUse({ control, identity, args }: HookCall): Promise<HookOutput> {
  const tool = clean(args.tool_name)
  if (tool === undefined) return {}
  const session = await control.session(identity)
  session.turns.noteTurnId(clean(args.turn_id))
  try {
    const verdict = await control.decide(session, tool, toolInput(args.tool_input), identity.cwd)
    return verdict.decision === 'allow' ? {} : denyTool(verdict.reason)
  } catch (error) {
    if (session.queue.peerTurn === null) throw error
    return denyTool(`agent-peers: the tool call could not be checked during a peer turn (${String(error)})`)
  }
}

async function hook(ctx: ToolContext, args: HookArgs) {
  const localKey = clean(args.session_id) ?? ctx.call.threadId ?? ctx.call.sessionKey
  if (localKey === undefined) return output({})
  const cwd = clean(args.cwd)
  const model = clean(args.model)
  const identity: Identity = { localKey, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) }
  const call: HookCall = { ctx, control: new BridgeControl(ctx.rt), identity, args }
  switch (clean(args.hook_event_name)) {
    case 'SessionStart':
      return output(await sessionStart(call))
    case 'UserPromptSubmit':
      return output(await promptSubmit(call))
    case 'Stop':
      return output(await stop(call))
    case 'PreToolUse':
      return output(await preToolUse(call))
    default:
      await call.control.session(identity)
      return output({})
  }
}

/** PreToolUse fails closed when the session it names is in a peer turn (the bridge knows it). */
function failClosed(ctx: ToolContext, args: HookArgs): boolean {
  if (clean(args.hook_event_name) !== 'PreToolUse') return false
  const key = clean(args.session_id) ?? ctx.call.threadId ?? ctx.call.sessionKey
  const session = key === undefined ? undefined : ctx.rt.registry.get(key)
  return (session?.queue.peerTurn ?? (key ? ctx.rt.registry.orphanTurn(key) : undefined) ?? null) !== null
}

/**
 * A hook never fails the agent (same contract as the Claude Code hooks): before the first join there
 * is no hub to register with, and an unreachable hub must not turn every Codex hook into an error.
 * The problem is logged and the hook answers "no opinion", except a PreToolUse during a peer turn,
 * which is denied.
 */
async function hookSafely(ctx: ToolContext, args: HookArgs) {
  try {
    return await hook(ctx, args)
  } catch (error) {
    const peers = toPeersError(error)
    ctx.rt.log(`peers_hook ${clean(args.hook_event_name) ?? '(no event)'}: ${peers.code}: ${peers.message}`)
    if (failClosed(ctx, args))
      return output(
        denyTool(`agent-peers: the tool call could not be checked during a peer turn (${peers.code})`),
      )
    return output({})
  }
}

export const hookTool: BridgeTool = defineTool({
  name: 'peers_hook',
  description:
    'Internal: called by the agent-peers plugin’s Codex lifecycle hooks. Never call this tool yourself.',
  schema: HookArgs,
  annotations: { readOnlyHint: false, openWorldHint: false },
  run: hookSafely,
})
