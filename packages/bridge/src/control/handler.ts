/**
 * The control-socket operations (ARCHITECTURE §5) mapped onto the session registry, the injection
 * queue and the peer-turn gate. Codex `peers_hook` calls reuse the same semantics.
 */
import { join } from 'node:path'
import type {
  ControlContext,
  ControlHandler,
  ControlParams,
  ControlResult,
  GateDecision,
  Injected,
} from '@agent-peers/core'
import {
  cachedListFiles,
  evaluateGate,
  evaluatePermission,
  fsExists,
  fsRealpath,
  type PeerTurnView,
} from '@agent-peers/core'
import type { Activity } from '@agent-peers/protocol'
import type { Runtime } from '../runtime'
import type { BridgeSession } from '../session/bridge-session'
import { resolveWorkspace } from '../session/card'

/** Stand-in workspace root when no hook reported one: it never contains the files a tool names. */
const NO_WORKSPACE = '.agent-peers-no-workspace'

/** SessionStart sources that replace the running conversation (ARCHITECTURE §5 `register`). */
const REPLACING_SOURCES: ReadonlySet<string> = new Set(['clear', 'resume', 'fork', 'branch'])

const ALLOW_OUTSIDE_TURN: GateDecision = { decision: 'allow', reason: 'not in a peer turn' }

/** While the agent is mid-turn a waiter must not wake it: a wake always starts its own turn. */
const MID_TURN: ReadonlySet<Activity> = new Set(['busy', 'awaiting_input'])

/** Recursive-search listings, shared by every gate call of this bridge (one peer turn searches a lot). */
const listFiles = cachedListFiles()

const denyGate = (reason: string): GateDecision => ({ decision: 'deny', reason: `agent-peers: ${reason}` })

/** The model-facing context a registration returns (handle, rooms, unread). */
export async function registerContext(session: BridgeSession): Promise<string | undefined> {
  const rooms = session.rooms
  if (rooms.length === 0) return undefined
  const where = rooms.map((r) => `@${r.handle} in room "${session.roomName(r.room_id)}"`).join(', ')
  const unread = (await session.unread()).length
  const inbox = unread > 0 ? ` ${unread} unread: call peers_inbox.` : ''
  return `[agent-peers] This session is ${where}. Peers can ask it questions; answer with peers_reply.${inbox}`
}

export function peerTurnOf(session: BridgeSession | undefined): PeerTurnView | null {
  const turn = session?.queue.peerTurn
  return turn ? { ask_ids: turn.ask_ids, room_ids: turn.room_ids } : null
}

export interface HookIdentity {
  readonly localKey: string
  readonly cwd?: string
  readonly model?: string
}

export class BridgeControl implements ControlHandler {
  /**
   * SessionStart's model per local key. Only SessionStart carries it, and its register fails before
   * the first `peers_join` (no hub yet), so later hook ops re-apply it once the session is open.
   */
  private models: ReadonlyMap<string, string> = new Map()

  constructor(private readonly rt: Runtime) {}

  /** Implicit registration (ONBOARDING §4): any hook op with an unknown key opens its session. */
  session(identity: HookIdentity, source = 'implicit'): Promise<BridgeSession> {
    this.rt.noteHook()
    const model = identity.model ?? this.models.get(identity.localKey)
    return this.rt.registry.ensure({
      localKey: identity.localKey,
      source,
      hooked: true,
      ...(identity.cwd ? { cwd: identity.cwd } : {}),
      ...(model ? { model } : {}),
    })
  }

  async register(p: ControlParams<'register'>): Promise<ControlResult<'register'>> {
    this.rt.noteHook()
    if (p.model) this.models = new Map(this.models).set(p.local_key, p.model)
    const supersedes = p.supersedes ?? this.inferSupersedes(p.local_key, p.source)
    const session = await this.rt.registry.ensure({
      localKey: p.local_key,
      source: p.source,
      hooked: true,
      ...(supersedes ? { supersedes } : {}),
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ...(p.model ? { model: p.model } : {}),
    })
    const context = await registerContext(session)
    return context ? { context } : {}
  }

  /**
   * SessionStart after /clear, /resume or /branch carries only the new key. One Claude Code process
   * runs one conversation at a time, so the bridge's other session is the one being replaced.
   */
  private inferSupersedes(localKey: string, source: string): string | undefined {
    if (!REPLACING_SOURCES.has(source) || this.rt.descriptor.sessionSource !== 'env') return undefined
    const others = this.rt.registry.keys().filter((key) => key !== localKey)
    return others.length === 1 ? others[0] : undefined
  }

  async activity(p: ControlParams<'activity'>): Promise<ControlResult<'activity'>> {
    const session = await this.session({ localKey: p.local_key })
    if (p.turn_start === true && p.state === 'busy') await session.turns.begin(undefined, p.carries ?? [])
    else session.setActivity(p.state)
    return {}
  }

  async take(p: ControlParams<'take'>): Promise<ControlResult<'take'>> {
    const session = await this.session({ localKey: p.local_key })
    const out = await session.handOut('take', Math.min(p.max_chars, this.rt.descriptor.maxInjectChars))
    return out ? { envelope: out.envelope, inject_id: out.inject_id } : null
  }

  /**
   * The asyncRewake waiter's long-poll. It hands out only while the session is not mid-turn (Stop's
   * `turn_end` set idle, or no hook reported activity yet), so a wake always starts its own turn and
   * never joins the turn that is ending or the user's own turn. A disposed session returns null at
   * once (the waiter then exits as superseded).
   */
  async wait(p: ControlParams<'wait'>, ctx: ControlContext): Promise<ControlResult<'wait'>> {
    const session = await this.session({ localKey: p.local_key })
    const maxChars = Math.min(
      p.max_chars ?? this.rt.descriptor.maxInjectChars,
      this.rt.descriptor.maxInjectChars,
    )
    const deadline = this.rt.clock.now() + p.timeout_ms
    session.presence.beginWait()
    let woke = false
    try {
      for (;;) {
        if (session.ended) return null
        const out = MID_TURN.has(session.activity) ? null : await session.handOut('wait', maxChars)
        if (out) {
          woke = true
          return { envelope: out.envelope, inject_id: out.inject_id }
        }
        const left = deadline - this.rt.clock.now()
        if (left <= 0 || (await session.changes.wait(this.rt.clock, left, ctx.signal)) === 'aborted')
          return null
      }
    } finally {
      session.presence.endWait(woke)
    }
  }

  async turn_end(p: ControlParams<'turn_end'>): Promise<ControlResult<'turn_end'>> {
    const session = await this.session({ localKey: p.local_key })
    const outcome = await session.turns.end({
      inject_ids: p.inject_ids,
      ...(p.last_message === undefined ? {} : { last_message: p.last_message }),
    })
    if (outcome.kind === 'nudge') return { reminder: outcome.reminder }
    session.setActivity('idle')
    return {}
  }

  async end(p: ControlParams<'end'>): Promise<ControlResult<'end'>> {
    this.rt.noteHook()
    await this.rt.registry.end(p.local_key)
    return {}
  }

  async gate(p: ControlParams<'gate'>): Promise<ControlResult<'gate'>> {
    let session = this.rt.registry.get(p.local_key)
    if (!session && this.rt.registry.orphanTurn(p.local_key) === undefined) {
      this.openInBackground(p.local_key, p.cwd)
      return ALLOW_OUTSIDE_TURN
    }
    // A peer turn survived a dropped hub connection: re-open the session (it adopts the turn) or deny.
    try {
      session ??= await this.session({ localKey: p.local_key, ...(p.cwd ? { cwd: p.cwd } : {}) })
    } catch (error) {
      return denyGate(`a peer turn is active and the bridge cannot check this call (${String(error)})`)
    }
    this.rt.noteHook()
    return this.decide(session, p.tool, p.input, p.cwd)
  }

  /**
   * Evaluates the peer-turn gate (ARCHITECTURE §8) for one tool call, with symlinks resolved, the
   * file system probed for recursive searches, and fail-closed on any error during a peer turn.
   */
  async decide(session: BridgeSession, tool: string, input: unknown, cwd?: string): Promise<GateDecision> {
    const peerTurn = peerTurnOf(session)
    if (peerTurn === null || !this.rt.descriptor.gated) return ALLOW_OUTSIDE_TURN
    try {
      // Unknown workspace: a root nothing lives in, so every path check fails closed.
      const root = session.workspace ?? (await resolveWorkspace(cwd)) ?? join(this.rt.userHome, NO_WORKSPACE)
      const config = await this.rt.config()
      return evaluateGate({
        peerTurn,
        tool,
        input,
        policy: config.peer_turn,
        workspaceRoot: root,
        userHome: this.rt.userHome,
        ...(cwd ? { cwd: fsRealpath(cwd) } : {}),
        realpath: fsRealpath,
        exists: fsExists,
        listFiles,
      })
    } catch (error) {
      return denyGate(`the tool call could not be checked during a peer turn (${String(error)})`)
    }
  }

  async permission(p: ControlParams<'permission'>): Promise<ControlResult<'permission'>> {
    const session = this.rt.registry.get(p.local_key)
    const decision = evaluatePermission({
      peerTurn: peerTurnOf(session),
      tool: p.tool,
      input: p.input,
      gatedAskIds: session?.turns.gatedAskIds() ?? [],
    })
    return decision.allow ? { allow: true, reason: decision.reason } : { reason: decision.reason }
  }

  /** ONBOARDING §4: accept only when this bridge serves that workspace or owns that key. */
  async autojoin(p: ControlParams<'autojoin'>): Promise<ControlResult<'autojoin'>> {
    const workspace = await resolveWorkspace(p.workspace)
    const matches = this.rt.registry
      .list()
      .filter((s) => s.localKey === p.local_key || (workspace !== undefined && s.workspace === workspace))
    for (const session of matches) await session.autojoin()
    return { accepted: matches.length > 0 }
  }

  undelivered(localKey: string, injected: Injected): void {
    this.rt.registry.get(localKey)?.queue.release(injected.inject_id)
  }

  /**
   * `take` output is printed by the prompt hook right away: once written it is delivered. A `wait`
   * hand-out stays leased until the woken turn reports busy (the waiter can still die before exit 2).
   */
  delivered(localKey: string, op: 'take' | 'wait', injected: Injected): void {
    if (op === 'take') this.rt.registry.get(localKey)?.queue.confirm([injected.inject_id])
  }

  private openInBackground(localKey: string, cwd: string | undefined): void {
    this.session({ localKey, ...(cwd ? { cwd } : {}) }).catch((error: unknown) =>
      this.rt.log(`implicit register for ${localKey} failed: ${String(error)}`),
    )
  }
}
