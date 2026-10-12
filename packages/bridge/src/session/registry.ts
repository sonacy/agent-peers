/**
 * local_key → BridgeSession (ARCHITECTURE §2: one bridge hosts 0..N sessions). Sessions open lazily
 * from the source each surface offers (ARCHITECTURE §3.1, §6.1, ONBOARDING §4):
 * - claude-code: CLAUDE_CODE_SESSION_ID at initialize, control-socket `register` (with `supersedes`
 *   on /clear, /resume, /branch) and implicit registration from any hook op with an unknown key;
 * - claude-desktop: one session, `claude-desktop@<host>`;
 * - codex / codex-desktop: `_meta["x-codex-turn-metadata"].thread_id` on every tools/call and the
 *   `session_id` of `peers_hook` calls, with the `session_key` argument as fallback.
 */
import type { Clock, EnvLike, InboxJournal, LocalConfig, LocalHome, PeerTurn } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import type { HubConnection } from '../hub/connection'
import type { Injector } from '../inject/injector'
import { desktopLocalKey, type SurfaceDescriptor } from '../surface/surfaces'
import { autojoinEntries, supersedesFor } from './autojoin'
import { BridgeSession, type SessionEvents } from './bridge-session'
import { buildCard, readGitInfo, resolveWorkspace } from './card'

export interface RegistryDeps {
  readonly descriptor: SurfaceDescriptor
  readonly home: LocalHome
  readonly config: () => Promise<LocalConfig>
  readonly clock: Clock
  readonly injector: Injector
  readonly connection: HubConnection
  readonly journals: () => Promise<InboxJournal>
  readonly host: string
  readonly env: EnvLike
  /** Directory used as the workspace when no hook reported a cwd (undefined: none). */
  readonly defaultWorkspace: string | undefined
  readonly agentVersion: () => string | undefined
  readonly log: (line: string) => void
  readonly onKeysChanged: (keys: readonly string[]) => void
}

export interface OpenRequest {
  readonly localKey: string
  /** SessionStart source, `mcp` (initialize / tool call) or `implicit` (unknown key on a hook op). */
  readonly source: string
  readonly supersedes?: string
  readonly cwd?: string
  readonly model?: string
  /** A hub the caller needs (peers_join with an invite link). */
  readonly hub?: string
  /** The request came from a lifecycle hook. */
  readonly hooked?: boolean
}

export interface CallIdentity {
  readonly sessionKey?: string
  /** Codex: `_meta["x-codex-turn-metadata"].thread_id`. */
  readonly threadId?: string
  readonly hub?: string
}

export class SessionRegistry {
  private sessions: ReadonlyMap<string, BridgeSession> = new Map()
  private opening: ReadonlyMap<string, Promise<BridgeSession>> = new Map()
  /** Peer turns of sessions dropped with the hub connection: the agent is still answering them. */
  private orphans: ReadonlyMap<string, PeerTurn> = new Map()

  constructor(private readonly deps: RegistryDeps) {
    deps.connection.onLost(() => this.dropAll())
  }

  get size(): number {
    return this.sessions.size
  }

  get(localKey: string): BridgeSession | undefined {
    return this.sessions.get(localKey)
  }

  list(): readonly BridgeSession[] {
    return [...this.sessions.values()]
  }

  keys(): readonly string[] {
    return [...this.sessions.keys()]
  }

  /** The peer turn a dropped session of `localKey` left open, if any. */
  orphanTurn(localKey: string): PeerTurn | undefined {
    return this.orphans.get(localKey)
  }

  /** Opens the session for `localKey` once; later calls refresh hook state, cwd and model. */
  async ensure(request: OpenRequest): Promise<BridgeSession> {
    if (request.hub !== undefined) await this.deps.connection.ensure(request.hub)
    const known = this.sessions.get(request.localKey) ?? (await this.opening.get(request.localKey))
    if (known) {
      await this.refresh(known, request)
      return known
    }
    const opening = this.open(request)
    this.opening = new Map(this.opening).set(request.localKey, opening)
    try {
      return await opening
    } finally {
      const next = new Map(this.opening)
      next.delete(request.localKey)
      this.opening = next
    }
  }

  /** The session a tool call acts for, per surface (ARCHITECTURE §3.1 "Which session is calling"). */
  async resolve(call: CallIdentity): Promise<BridgeSession> {
    const hub = call.hub === undefined ? {} : { hub: call.hub }
    const source = this.deps.descriptor.sessionSource
    if (source === 'single')
      return this.ensure({ localKey: desktopLocalKey(this.deps.host), source: 'mcp', ...hub })
    if (source === 'turn-metadata') {
      const key = call.threadId ?? call.sessionKey
      if (key !== undefined) return this.ensure({ localKey: key, source: 'implicit', ...hub })
      return this.only(call)
    }
    if (call.sessionKey !== undefined) {
      if (this.sessions.has(call.sessionKey) || this.sessions.size === 0)
        return this.ensure({ localKey: call.sessionKey, source: 'mcp', ...hub })
      throw new PeersError('invalid_params', `unknown session_key ${call.sessionKey}: ${this.describeKeys()}`)
    }
    const envKey = this.deps.env.CLAUDE_CODE_SESSION_ID?.trim()
    if (this.sessions.size === 0 && envKey) return this.ensure({ localKey: envKey, source: 'mcp', ...hub })
    return this.only(call)
  }

  private async only(call: CallIdentity): Promise<BridgeSession> {
    const sessions = this.list()
    const sole = sessions[0]
    if (sessions.length === 1 && sole) {
      if (call.hub !== undefined) await this.deps.connection.ensure(call.hub)
      return sole
    }
    if (sessions.length === 0)
      throw new PeersError(
        'unknown_session',
        'no agent session is registered with this bridge yet (hooks not running or not trusted?)',
      )
    throw new PeersError('invalid_params', `several sessions share this bridge: ${this.describeKeys()}`)
  }

  private describeKeys(): string {
    return `pass session_key, one of ${this.keys().join(', ')}`
  }

  private async refresh(session: BridgeSession, request: OpenRequest): Promise<void> {
    if (request.hooked) session.noteHook()
    if (request.model) session.setModel(request.model)
    const workspace = await resolveWorkspace(request.cwd)
    if (workspace === undefined || !session.setWorkspace(workspace)) return
    const config = await this.deps.config()
    const git = config.workspace.share === 'full' ? await readGitInfo(workspace) : undefined
    const card = buildCard({ ...this.cardSpec(session.tier, config), workspace, ...(git ? { git } : {}) })
    if (card.workspace) await session.handle.update({ workspace: card.workspace })
    await session.autojoin()
  }

  private cardSpec(tier: BridgeSession['tier'], config: LocalConfig) {
    const agentVersion = this.deps.agentVersion()
    return {
      descriptor: this.deps.descriptor,
      host: this.deps.host,
      tier,
      share: config.workspace.share,
      ...(agentVersion ? { agentVersion } : {}),
    }
  }

  private async open(request: OpenRequest): Promise<BridgeSession> {
    const config = await this.deps.config()
    const { client, hub } = await this.deps.connection.ensure(request.hub)
    const workspace = await resolveWorkspace(request.cwd ?? this.deps.defaultWorkspace)
    const git = workspace && config.workspace.share === 'full' ? await readGitInfo(workspace) : undefined
    const hooked = request.hooked === true
    const target = {
      localKey: request.localKey,
      surface: this.deps.descriptor.surface,
      activity: 'unknown' as const,
      hooked,
      waiting: false,
    }
    const fallback = hooked ? this.deps.descriptor.hookedTier : this.deps.descriptor.baseTier
    const tier = this.deps.injector.tier?.(target) ?? fallback
    const card = buildCard({
      ...this.cardSpec(tier, config),
      ...(workspace ? { workspace } : {}),
      ...(git ? { git } : {}),
      ...(request.model ? { model: request.model } : {}),
    })
    const scope = { hub, agent: this.deps.descriptor.agentKind, localKey: request.localKey, workspace }
    const supersedes =
      request.supersedes ?? supersedesFor(await autojoinEntries(this.deps.home, scope), request.localKey)
    const deps = {
      descriptor: this.deps.descriptor,
      home: this.deps.home,
      config,
      clock: this.deps.clock,
      injector: this.deps.injector,
      client,
      hub,
      journal: async (sessionId: string) => (await this.deps.journals()).session(sessionId),
      events: this.events(),
      log: this.deps.log,
    }
    const init = {
      localKey: request.localKey,
      card,
      hooked,
      ...(supersedes ? { supersedes } : {}),
      ...(workspace ? { workspace } : {}),
    }
    const session = await BridgeSession.open(
      deps,
      init,
      supersedes ? [request.localKey, supersedes] : [request.localKey],
    )
    this.replace(request.localKey, session, request.supersedes)
    this.adoptOrphan(request.localKey, session)
    this.deps.log(`session ${request.localKey} open (${request.source})`)
    session.pump()
    return session
  }

  private adoptOrphan(localKey: string, session: BridgeSession): void {
    const turn = this.orphans.get(localKey)
    if (turn === undefined) return
    session.turns.adopt(turn)
    const next = new Map(this.orphans)
    next.delete(localKey)
    this.orphans = next
  }

  private replace(localKey: string, session: BridgeSession, superseded: string | undefined): void {
    const next = new Map(this.sessions).set(localKey, session)
    const old = superseded === undefined ? undefined : next.get(superseded)
    if (old && superseded !== localKey) {
      old.dispose()
      next.delete(superseded as string)
    }
    this.sessions = next
    this.deps.onKeysChanged(this.keys())
  }

  private events(): SessionEvents {
    return {
      roomGone: (session, roomId) => void this.forgetRoom(session, roomId),
      handleRenamed: (session, roomId, oldHandle, newHandle) =>
        void this.renameRemembered(session, roomId, oldHandle, newHandle),
    }
  }

  /** PROTOCOL §4/§8: a room the session lost is dropped from auto-join and never re-joined. */
  private async forgetRoom(session: BridgeSession, roomId: string): Promise<void> {
    const hub = this.deps.connection.hub
    if (hub === undefined) return
    const entries = (await this.deps.home.readAutojoin()).filter(
      (e) =>
        e.hub === hub &&
        e.room_id === roomId &&
        (e.workspace === session.workspace || e.local_key === session.localKey),
    )
    for (const entry of entries)
      await this.deps.home.forgetAutojoin({ hub, room_id: roomId, workspace: entry.workspace })
  }

  /** PROTOCOL §2.2: an owner/admin rename updates the remembered handle. */
  private async renameRemembered(_s: BridgeSession, roomId: string, from: string, to: string): Promise<void> {
    const hub = this.deps.connection.hub
    if (hub === undefined) return
    const entries = await this.deps.home.readAutojoin()
    for (const entry of entries.filter((e) => e.hub === hub && e.room_id === roomId && e.handle === from))
      await this.deps.home.rememberAutojoin({ ...entry, handle: to })
  }

  /** SessionEnd: closes the hub session and forgets it. */
  async end(localKey: string): Promise<void> {
    if (this.orphans.has(localKey)) {
      const orphans = new Map(this.orphans)
      orphans.delete(localKey)
      this.orphans = orphans
    }
    const session = this.sessions.get(localKey)
    if (!session) return
    const next = new Map(this.sessions)
    next.delete(localKey)
    this.sessions = next
    this.deps.onKeysChanged(this.keys())
    await session.close()
  }

  async closeAll(): Promise<void> {
    const sessions = this.list()
    this.sessions = new Map()
    await Promise.all(sessions.map((s) => s.close()))
  }

  /**
   * The hub connection is gone. Sessions are dropped, but an open peer turn is remembered: the agent
   * still has the peer's envelope in context, so its gate must keep applying (BridgeControl.gate).
   */
  private dropAll(): void {
    const sessions = this.list()
    this.sessions = new Map()
    const orphans = new Map(this.orphans)
    for (const session of sessions) {
      const turn = session.queue.peerTurn
      if (turn !== null) orphans.set(session.localKey, turn)
      session.dispose()
    }
    this.orphans = orphans
    this.deps.onKeysChanged([])
  }
}
