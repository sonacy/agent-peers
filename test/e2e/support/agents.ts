/**
 * Simulated agents: a real bridge plus the lifecycle events the real agent would produce around it.
 * Each surface receives peer envelopes through its own mechanism (ARCHITECTURE §6.1):
 * - Claude Code: the asyncRewake waiter (`hook wait`) exits 2 with the envelope on stderr; Stop ends
 *   the turn and re-arms the waiter.
 * - Claude Desktop: no hooks; the model calls peers_wait (listen mode) or peers_inbox.
 * - Codex CLI / desktop: the bridge runs `codex queue --thread <id> --message <envelope>` (the fake
 *   CLI records it); the queued turn then fires UserPromptSubmit, and Stop ends it. Hooks are
 *   `mcp_tool` handlers calling peers_hook.
 */
import { type Bridge, type BridgeOptions, startBridge, type ToolOutput } from './bridge'
import { claudePayload, type HookRun, runClaudeHook, startWaiter, type Waiter } from './claude-hooks'
import type { Machine } from './machine'
import type { Surface } from './profiles'
import { eventually, within } from './wait'

export interface Delivery {
  readonly envelope: string
  /** The ask_id of an ASK envelope. */
  readonly askId: string | undefined
}

export interface Agent {
  readonly surface: Surface
  readonly machine: Machine
  readonly bridge: Bridge
  /** The session's local key (Desktop: undefined, the bridge derives `claude-desktop@<host>`). */
  readonly key: string | undefined
  /** SessionStart (and arming the waiter on Claude Code). */
  start(source?: string): Promise<void>
  /** The next envelope delivered through this surface's own mechanism. */
  receive(timeoutMs?: number): Promise<Delivery>
  /** The model's turn ended (Stop). Returns the Stop hook's output, if the surface has one. */
  endTurn(lastMessage?: string): Promise<Readonly<Record<string, unknown>>>
  call(tool: string, args?: Readonly<Record<string, unknown>>): Promise<ToolOutput>
  ok(tool: string, args?: Readonly<Record<string, unknown>>): Promise<ToolOutput>
  /** The agent quits: waiters die with it and the bridge's stdin closes. */
  close(): Promise<void>
}

const ASK_ID = /ask_id (\S+)/

export const askIdOf = (envelope: string): string | undefined => ASK_ID.exec(envelope)?.[1]

const delivery = (envelope: string): Delivery => ({ envelope, askId: askIdOf(envelope) })

const DEFAULT_RECEIVE_MS = 30_000

function parseJson(text: string): Readonly<Record<string, unknown>> {
  return text.trim() === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

// ---- Claude Code ------------------------------------------------------------------------------

export class ClaudeCodeAgent implements Agent {
  readonly surface = 'claude-code' as const
  private waiters: readonly Waiter[] = []
  /** Waiters whose wake a `receive` already returned. */
  private consumed: ReadonlySet<Waiter> = new Set()

  constructor(
    readonly machine: Machine,
    readonly bridge: Bridge,
    public key: string,
  ) {}

  /** Arms a waiter like the plugin's async hooks on SessionStart / Stop / StopFailure do. */
  arm(event: 'SessionStart' | 'Stop' | 'StopFailure', extra: Readonly<Record<string, unknown>> = {}): Waiter {
    const waiter = startWaiter(this.machine, claudePayload(this.machine, event, this.key, extra))
    this.waiters = [...this.waiters, waiter]
    return waiter
  }

  hook(event: Parameters<typeof runClaudeHook>[1], extra: Readonly<Record<string, unknown>> = {}) {
    return runClaudeHook(this.machine, event, claudePayload(this.machine, event, this.key, extra))
  }

  async start(source = 'startup'): Promise<void> {
    await this.hook('SessionStart', { source })
    this.arm('SessionStart', { source })
  }

  /** Switches the conversation (/clear, /resume, fork): a new session id on the same bridge. */
  async switchTo(key: string, source: string): Promise<HookRun> {
    this.key = key
    const run = await this.hook('SessionStart', { source })
    this.arm('SessionStart', { source })
    return run
  }

  /** Waiters that may still deliver a wake: running, or exited 2 with a wake nobody received yet. */
  private candidates(): readonly Waiter[] {
    return this.waiters.filter((w) => !this.consumed.has(w))
  }

  async receive(timeoutMs = DEFAULT_RECEIVE_MS): Promise<Delivery> {
    const waiters = this.candidates()
    if (waiters.length === 0) throw new Error('no asyncRewake waiter is armed')
    const { waiter, run } = await within(
      'the asyncRewake waiter to wake the session',
      Promise.any(
        waiters.map((w) =>
          w.result.then((r) => (r.exitCode === 2 ? { waiter: w, run: r } : Promise.reject(r))),
        ),
      ),
      timeoutMs,
    )
    this.consumed = new Set(this.consumed).add(waiter)
    return delivery(run.stderr)
  }

  /**
   * Claude Code runs a Stop event's hooks in parallel: the sync Stop hook (turn_end) and the async
   * waiter start together, so the waiter may poll before turn_end lands.
   */
  async endTurn(lastMessage = 'done'): Promise<Readonly<Record<string, unknown>>> {
    const stop = this.hook('Stop', { last_assistant_message: lastMessage })
    this.arm('Stop', { last_assistant_message: lastMessage })
    return parseJson((await stop).stdout)
  }

  call(tool: string, args?: Readonly<Record<string, unknown>>) {
    return this.bridge.call(tool, args)
  }

  ok(tool: string, args?: Readonly<Record<string, unknown>>) {
    return this.bridge.ok(tool, args)
  }

  killWaiters(): void {
    for (const waiter of this.waiters) waiter.kill()
    this.waiters = []
  }

  async close(): Promise<void> {
    this.killWaiters()
    await this.bridge.close()
  }
}

// ---- Claude Desktop ---------------------------------------------------------------------------

export class DesktopAgent implements Agent {
  readonly surface = 'claude-desktop' as const
  readonly key = undefined
  /** How the model looks for envelopes: listen mode (peers_wait) or the per-turn peers_inbox check. */
  mode: 'wait' | 'inbox' = 'wait'

  constructor(
    readonly machine: Machine,
    readonly bridge: Bridge,
  ) {}

  async start(): Promise<void> {}

  async receive(timeoutMs = DEFAULT_RECEIVE_MS): Promise<Delivery> {
    if (this.mode === 'inbox') {
      const out = await eventually(
        'peers_inbox to show an envelope',
        async () => {
          const result = await this.bridge.ok('peers_inbox')
          return /\[agent-peers\] (ASK|REPLY) /.test(result.text) ? result : undefined
        },
        { timeoutMs, intervalMs: 200 },
      )
      return delivery(out.text)
    }
    const out = await eventually(
      'peers_wait to return an envelope',
      async () => {
        const result = await this.bridge.ok('peers_wait', { timeout_seconds: 5 })
        return result.structured?.inject_id ? result : undefined
      },
      { timeoutMs, intervalMs: 0 },
    )
    return delivery(out.text)
  }

  /** Poll tier: the model checks peers_inbox at the start of a turn. */
  async inbox(): Promise<ToolOutput> {
    return this.bridge.ok('peers_inbox')
  }

  async endTurn(): Promise<Readonly<Record<string, unknown>>> {
    return {}
  }

  call(tool: string, args?: Readonly<Record<string, unknown>>) {
    return this.bridge.call(tool, args)
  }

  ok(tool: string, args?: Readonly<Record<string, unknown>>) {
    return this.bridge.ok(tool, args)
  }

  close(): Promise<void> {
    return this.bridge.close()
  }
}

// ---- Codex CLI / Codex desktop -----------------------------------------------------------------

export class CodexAgent implements Agent {
  private consumed = 0
  private turns = 0
  /** The running Codex turn's id: turn-scoped hooks (UserPromptSubmit, Stop) carry it. */
  private turnId = 'turn-0'

  constructor(
    readonly surface: 'codex' | 'codex-desktop',
    readonly machine: Machine,
    readonly bridge: Bridge,
    readonly key: string,
  ) {}

  /** An `mcp_tool` hook handler calling peers_hook with the templated event fields. */
  async hook(event: string, fields: Readonly<Record<string, unknown>> = {}) {
    const out = await this.bridge.call(
      'peers_hook',
      {
        agent: 'codex',
        hook_event_name: event,
        session_id: this.key,
        cwd: this.machine.workspace,
        ...fields,
      },
      { meta: false },
    )
    if (out.isError) throw new Error(`peers_hook ${event} failed: ${out.text}`)
    return out.structured ?? {}
  }

  async start(source = 'startup'): Promise<void> {
    await this.hook('SessionStart', { source, model: 'gpt-5.5-codex' })
  }

  /** The next `codex queue` call for this thread; the queued turn then starts (UserPromptSubmit). */
  async receive(timeoutMs = DEFAULT_RECEIVE_MS): Promise<Delivery> {
    const { call, index } = await eventually(
      'the bridge to run `codex queue` for this thread',
      async () => {
        const calls = await this.machine.queueCalls()
        const i = calls.findIndex((c, n) => n >= this.consumed && c.thread === this.key)
        const found = calls[i]
        return found ? { call: found, index: i } : undefined
      },
      { timeoutMs },
    )
    this.consumed = index + 1
    await this.prompt(call.message)
    return delivery(call.message)
  }

  /** UserPromptSubmit: returns the additionalContext the hook injected (held envelopes). */
  async prompt(prompt = 'hi'): Promise<string | undefined> {
    this.turnId = `turn-${++this.turns}`
    const out = await this.hook('UserPromptSubmit', { prompt, turn_id: this.turnId })
    const specific = out.hookSpecificOutput as { additionalContext?: string } | undefined
    return specific?.additionalContext
  }

  async endTurn(lastMessage = 'done'): Promise<Readonly<Record<string, unknown>>> {
    return this.hook('Stop', {
      last_assistant_message: lastMessage,
      stop_hook_active: 'false',
      turn_id: this.turnId,
    })
  }

  call(tool: string, args?: Readonly<Record<string, unknown>>) {
    return this.bridge.call(tool, args)
  }

  ok(tool: string, args?: Readonly<Record<string, unknown>>) {
    return this.bridge.ok(tool, args)
  }

  close(): Promise<void> {
    return this.bridge.close()
  }
}

// ---- factory ----------------------------------------------------------------------------------

export interface AgentOptions extends Omit<BridgeOptions, 'sessionKey'> {
  /** Claude Code session id / Codex thread id (default derived from the machine name). */
  readonly key?: string
}

export async function startAgent(
  machine: Machine,
  surface: Surface,
  options: AgentOptions = {},
): Promise<Agent> {
  const key = options.key ?? `${machine.name}-${surface}-1`
  switch (surface) {
    case 'claude-code':
      return new ClaudeCodeAgent(
        machine,
        await startBridge(machine, surface, { ...options, sessionKey: key }),
        key,
      )
    case 'claude-desktop':
      return new DesktopAgent(machine, await startBridge(machine, surface, options))
    default:
      return new CodexAgent(
        surface,
        machine,
        await startBridge(machine, surface, { ...options, sessionKey: key }),
        key,
      )
  }
}
