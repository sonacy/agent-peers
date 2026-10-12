/**
 * createBridge: the stdio MCP server `agent-peers mcp --surface <s>` runs (ARCHITECTURE §2, §5, §6).
 * Nothing happens before MCP `initialize`: the surface is verified there, and only then does the
 * bridge build its runtime, bind the control socket (Claude Code) and open the env session.
 */

import type { Readable, Writable } from 'node:stream'
import {
  type Clock,
  ControlServer,
  type EnvLike,
  InboxJournal,
  type LocalConfig,
  LocalHome,
  type ProcessTree,
  systemClock,
} from '@agent-peers/core'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Implementation } from '@modelcontextprotocol/sdk/types.js'
import { BridgeControl } from './control/handler'
import { defaultHubClientFactory, type HubClientFactory, HubConnection } from './hub/connection'
import type { FetchLike } from './hub/invite'
import { defaultInjector, type Injector } from './inject/injector'
import { GuardTransport } from './mcp/guard-transport'
import { createMcpServer } from './mcp/server'
import { openInBrowser } from './open-url'
import { HOOK_GRACE_MS, type Runtime } from './runtime'
import { ADAPTER_VERSION, shortHost } from './session/card'
import { SessionRegistry } from './session/registry'
import { INERT_INSTRUCTIONS, instructionsFor } from './surface/instructions'
import { type BridgeSurface, descriptorFor, desktopLocalKey } from './surface/surfaces'
import { type SurfaceCheck, type SurfaceVerdict, verifySurface } from './surface/verify'

export interface ControlSocketOptions {
  /** Default `<home>/run`. */
  readonly runDir?: string
  readonly pid?: number
  readonly ancestorPids?: readonly number[]
  readonly tree?: ProcessTree
}

export interface BridgeOptions {
  readonly surface: BridgeSurface
  /** The agent-peers home (`AGENT_PEERS_HOME`), or a LocalHome. Default: resolved from `env`. */
  readonly home?: string | LocalHome
  readonly env?: EnvLike
  /** Streams for `start()` (default: process stdin/stdout). */
  readonly stdio?: { readonly stdin: Readable; readonly stdout: Writable }
  readonly clock?: Clock
  readonly hubClientFactory?: HubClientFactory
  /** `false` never binds the control socket; options tune it (Claude Code only). */
  readonly controlSocket?: false | ControlSocketOptions
  readonly injector?: Injector
  readonly host?: string
  readonly userHome?: string
  /** Workspace used when no hook reported a cwd (Claude Code default: CLAUDE_PROJECT_DIR or cwd). */
  readonly cwd?: string
  readonly surfaceCheck?: SurfaceCheck
  readonly fetch?: FetchLike
  readonly openUrl?: (url: string) => Promise<boolean>
  readonly log?: (line: string) => void
}

export interface Bridge {
  readonly server: Server
  readonly verdict: SurfaceVerdict | undefined
  readonly runtime: Runtime | undefined
  readonly controlSocketPath: string | undefined
  /** Resolves once activation after `initialize` finished (control socket bound, env session opened). */
  ready(): Promise<void>
  connect(transport: Transport): Promise<void>
  /** Connects over stdio. */
  start(): Promise<void>
  close(): Promise<void>
  /** Resolves once the bridge has shut down (stdin closed, `close()`). */
  whenClosed(): Promise<void>
}

const stderrLog = (line: string): void => {
  process.stderr.write(`[agent-peers] ${line}\n`)
}

function resolveHome(options: BridgeOptions, env: EnvLike): LocalHome {
  if (options.home instanceof LocalHome) return options.home
  return new LocalHome({
    env,
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
  })
}

class BridgeImpl implements Bridge {
  readonly server: Server
  private verdictValue: SurfaceVerdict | undefined
  private rt: Runtime | undefined
  private control: ControlServer | undefined
  private activation: Promise<void> = Promise.resolve()
  private agentVersion: string | undefined
  private readonly env: EnvLike
  private readonly clock: Clock
  private readonly home: LocalHome
  private readonly log: (line: string) => void
  private closed = false
  private readonly closedSignal = Promise.withResolvers<void>()

  constructor(private readonly options: BridgeOptions) {
    this.env = options.env ?? process.env
    this.clock = options.clock ?? systemClock
    this.home = resolveHome(options, this.env)
    this.log = options.log ?? stderrLog
    this.server = createMcpServer(instructionsFor(options.surface), {
      runtime: () => this.rt,
      inactiveReason: () =>
        `agent-peers is not active in this client: ${this.verdictValue?.reason ?? 'not initialized yet'}`,
    })
  }

  get verdict(): SurfaceVerdict | undefined {
    return this.verdictValue
  }

  get runtime(): Runtime | undefined {
    return this.rt
  }

  get controlSocketPath(): string | undefined {
    return this.control?.socketPath
  }

  ready(): Promise<void> {
    return this.activation
  }

  connect(transport: Transport): Promise<void> {
    const guarded = new GuardTransport(transport, {
      onInitialize: (client) => this.onInitialize(client),
      instructions: () =>
        this.verdictValue?.ok === false ? INERT_INSTRUCTIONS : instructionsFor(this.options.surface),
    })
    return this.server.connect(guarded)
  }

  /** Serves MCP over stdio; the agent closing stdin ends the bridge (sessions go offline at once). */
  async start(): Promise<void> {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
    const stdin = this.options.stdio?.stdin ?? process.stdin
    const stdout = this.options.stdio?.stdout ?? process.stdout
    const stop = () => void this.close()
    stdin.once('end', stop)
    stdin.once('close', stop)
    this.server.onclose = stop
    await this.connect(new StdioServerTransport(stdin, stdout))
  }

  whenClosed(): Promise<void> {
    return this.closedSignal.promise
  }

  private onInitialize(client: Implementation | undefined): void {
    if (this.verdictValue) return
    const verdict = verifySurface({
      requested: this.options.surface,
      client,
      env: this.env,
      ...(this.options.surfaceCheck ? { mode: this.options.surfaceCheck } : {}),
    })
    this.verdictValue = verdict
    if (!verdict.ok) {
      this.log(`inactive: ${verdict.reason}`)
      return
    }
    this.agentVersion = client?.version || undefined
    this.rt = this.buildRuntime(verdict.surface)
    this.activation = this.activate(this.rt).catch((error: unknown) =>
      this.log(`activation: ${String(error)}`),
    )
  }

  private buildRuntime(surface: BridgeSurface): Runtime {
    const descriptor = descriptorFor(surface)
    const host = this.options.host ?? shortHost()
    const home = this.home
    let config: Promise<LocalConfig> | undefined
    const loadConfig = (): Promise<LocalConfig> => {
      config ??= home.readConfig()
      config.catch(() => {
        config = undefined
      })
      return config
    }
    let journals: Promise<InboxJournal> | undefined
    const openJournals = (): Promise<InboxJournal> => {
      journals ??= home.ensure().then(() => InboxJournal.open({ dir: home.paths.inbox, clock: this.clock }))
      return journals
    }
    const connection = new HubConnection({
      home,
      config: loadConfig,
      factory: this.options.hubClientFactory ?? defaultHubClientFactory,
      clock: this.clock,
      insecure: this.env.AGENT_PEERS_INSECURE === '1',
      log: this.log,
      bridge: () => ({
        agent_kind: descriptor.agentKind,
        adapter: ADAPTER_VERSION,
        host,
        ...(this.agentVersion ? { agent_version: this.agentVersion.slice(0, 64) } : {}),
      }),
    })
    const injector = this.options.injector ?? defaultInjector(surface)
    const registry = new SessionRegistry({
      descriptor,
      home,
      config: loadConfig,
      clock: this.clock,
      injector,
      connection,
      journals: openJournals,
      host,
      env: this.env,
      defaultWorkspace: this.defaultWorkspace(surface),
      agentVersion: () => this.agentVersion,
      log: this.log,
      onKeysChanged: (keys) => {
        this.control?.setLocalKeys(keys).catch((error: unknown) => this.log(`run file: ${String(error)}`))
      },
    })
    const startedAt = this.clock.now()
    let hookSeen = false
    return {
      descriptor,
      home,
      registry,
      connection,
      injector,
      clock: this.clock,
      env: this.env,
      userHome: home.userHome,
      host,
      startedAt,
      fetch: this.options.fetch ?? ((input, init) => fetch(input, init)),
      config: loadConfig,
      log: this.log,
      openUrl: this.options.openUrl ?? openInBrowser,
      noteHook: () => {
        hookSeen = true
      },
      hooksMissing: () =>
        descriptor.hooks !== 'none' && !hookSeen && this.clock.now() - startedAt >= HOOK_GRACE_MS,
    }
  }

  private defaultWorkspace(surface: BridgeSurface): string | undefined {
    if (this.options.cwd !== undefined) return this.options.cwd
    if (surface !== 'claude-code') return undefined
    return this.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd()
  }

  /** Binds the control socket (Claude Code) and opens the session the environment names. */
  private async activate(rt: Runtime): Promise<void> {
    const socket = this.options.controlSocket
    if (rt.descriptor.hooks === 'control-socket' && socket !== false) {
      await this.home.ensure()
      this.control = await ControlServer.start({
        runDir: socket?.runDir ?? this.home.paths.run,
        handler: new BridgeControl(rt),
        agentKind: rt.descriptor.agentKind,
        clock: this.clock,
        ...(socket?.pid === undefined ? {} : { pid: socket.pid }),
        ...(socket?.ancestorPids === undefined ? {} : { ancestorPids: socket.ancestorPids }),
        ...(socket?.tree === undefined ? {} : { tree: socket.tree }),
      })
      if (this.closed) await this.control.close()
    }
    const key = this.initialKey(rt)
    if (key === undefined) return
    const { hubs } = await this.home.readCredentials()
    if (Object.keys(hubs).length === 0) return
    await rt.registry.ensure({ localKey: key, source: 'mcp' })
  }

  private initialKey(rt: Runtime): string | undefined {
    if (rt.descriptor.sessionSource === 'single') return desktopLocalKey(rt.host)
    if (rt.descriptor.sessionSource === 'env') return this.env.CLAUDE_CODE_SESSION_ID?.trim() || undefined
    return undefined
  }

  async close(): Promise<void> {
    if (this.closed) return this.closedSignal.promise
    this.closed = true
    try {
      await this.shutdown()
    } finally {
      this.closedSignal.resolve()
    }
  }

  private async shutdown(): Promise<void> {
    await this.activation
    const rt = this.rt
    if (rt) {
      await rt.registry.closeAll()
      await rt.connection.close()
      await rt.injector.close?.()
    }
    await this.control?.close()
    await this.server.close().catch(() => undefined)
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  return new BridgeImpl(options)
}
