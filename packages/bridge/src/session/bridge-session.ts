/**
 * One agent session as the bridge sees it: the hub session (SessionHandle), its inbox journal, its
 * injection queue, inline ask waiters and card presence. Inbound messages are routed by inbound.ts;
 * envelopes leave through `wait` / `take` / tools or are pushed through the injector when the
 * surface can wake an idle session (PROTOCOL §6.3, §7; ARCHITECTURE §5, §8).
 */
import {
  type CardInput,
  type Clock,
  type HandOut,
  type HubClient,
  type InjectChannel,
  InjectQueue,
  type JournalEntry,
  type LocalConfig,
  type LocalHome,
  SessionHandle,
  type SessionJournal,
  type SessionRoom,
  type Unsubscribe,
} from '@agent-peers/core'
import {
  type Activity,
  buildEnvelope,
  type InjectTier,
  isPeersError,
  type ReplyState,
} from '@agent-peers/protocol'
import type { Injector, InjectTarget } from '../inject/injector'
import type { SurfaceDescriptor } from '../surface/surfaces'
import { applyAutojoin, autojoinEntries } from './autojoin'
import { Delivery, type HandOutOptions } from './delivery'
import { type InboundHost, isForMe, routeAskUpdate, routeMessage } from './inbound'
import { CardPresence } from './presence'
import { Roster } from './roster'
import { AskWaiters, ChangeSignal, type PeerMessage } from './signals'
import { Turns } from './turns'

/** A handed-out envelope stays leased this long before it is re-queued (crash safety net). */
export const INJECT_LEASE_MS = 15 * 60 * 1000

export interface SessionEvents {
  /** The session lost a room (removed, kicked, left while offline): forget it in autojoin.json. */
  roomGone(session: BridgeSession, roomId: string): void
  /** An owner or admin renamed this session's handle: update autojoin.json. */
  handleRenamed(session: BridgeSession, roomId: string, oldHandle: string, newHandle: string): void
}

export interface SessionDeps {
  readonly descriptor: SurfaceDescriptor
  readonly home: LocalHome
  readonly config: LocalConfig
  readonly clock: Clock
  readonly injector: Injector
  readonly client: HubClient
  /** Hub origin. */
  readonly hub: string
  readonly journal: (sessionId: string) => Promise<SessionJournal>
  readonly events: SessionEvents
  readonly log: (line: string) => void
}

export interface SessionInit {
  readonly localKey: string
  readonly card: CardInput
  readonly supersedes?: string
  readonly workspace?: string
  readonly hooked: boolean
}

export interface SentAsk {
  readonly text: string
  readonly roomId: string
  readonly to: string
}

export class BridgeSession implements InboundHost {
  readonly localKey: string
  readonly handle: SessionHandle
  readonly queue: InjectQueue<PeerMessage>
  readonly waiters = new AskWaiters()
  readonly changes = new ChangeSignal()
  readonly roster = new Roster()
  /** Card presence: activity, tier, listen mode and waiter bookkeeping. */
  readonly presence: CardPresence
  private readonly journalReady = Promise.withResolvers<SessionJournal>()
  private readonly subscriptions: readonly Unsubscribe[]
  readonly delivery: Delivery
  /** The peer-turn lifecycle: `turns.begin()` on UserPromptSubmit, `turns.end()` on Stop. */
  readonly turns: Turns
  private sentAsks: ReadonlyMap<string, SentAsk> = new Map()
  private work: Promise<void> = Promise.resolve()
  private workspacePath: string | undefined
  private endedFlag = false

  private constructor(
    private readonly deps: SessionDeps,
    init: SessionInit,
  ) {
    this.localKey = init.localKey
    this.workspacePath = init.workspace
    this.journalReady.promise.catch(() => undefined)
    this.handle = new SessionHandle(deps.client, {
      localKey: init.localKey,
      card: init.card,
      clock: deps.clock,
      ...(init.supersedes ? { supersedes: init.supersedes } : {}),
    })
    this.queue = new InjectQueue<PeerMessage>({
      claim: (askId) => this.handle.claim(askId),
      render: (item, maxChars) => this.render(item.message, maxChars),
      clock: deps.clock,
      leaseMs: INJECT_LEASE_MS,
      peerTurnsPerHour: deps.config.injection.peer_turns_per_hour,
      maxReplayAgeMs: deps.config.injection.max_replay_age_ms,
      replyFallback: deps.config.reply_fallback,
      canNudge: deps.descriptor.canNudge,
      onClaimError: (askId, error, outcome) =>
        deps.log(
          `ask.claim ${askId} failed (${outcome === 'retry' ? 'will retry' : outcome}): ${String(error)}`,
        ),
    })
    this.delivery = new Delivery(this, deps)
    this.turns = new Turns(this)
    this.presence = new CardPresence(
      { ...deps, localKey: init.localKey, update: (patch) => this.handle.update(patch) },
      { hooked: init.hooked, tier: init.card.inject ?? deps.descriptor.baseTier },
    )
    this.subscriptions = this.subscribe()
  }

  /** Opens the hub session, loads its journal and applies auto-join. */
  static async open(deps: SessionDeps, init: SessionInit, identityKeys: readonly string[]) {
    const session = new BridgeSession(deps, init)
    try {
      await session.handle.open()
      session.journalReady.resolve(await deps.journal(session.handle.sessionId))
    } catch (error) {
      session.journalReady.reject(error)
      session.dispose()
      throw error
    }
    await session
      .autojoin(identityKeys)
      .catch((error: unknown) => deps.log(`autojoin for ${init.localKey} failed: ${String(error)}`))
    return session
  }

  // ---- accessors -----------------------------------------------------------------------------

  get sessionId(): string {
    return this.handle.sessionId
  }

  get rooms(): readonly SessionRoom[] {
    return this.handle.view.rooms
  }

  get accepting(): boolean {
    return this.handle.view.card.accepting !== false
  }

  get activity(): Activity {
    return this.presence.activity
  }

  get hooked(): boolean {
    return this.presence.hooked
  }

  get tier(): InjectTier {
    return this.presence.tier
  }

  get target(): InjectTarget {
    return this.presence.target
  }

  get workspace(): string | undefined {
    return this.workspacePath
  }

  /** Disposed (superseded, connection lost) or closed: it hands out nothing any more. */
  get ended(): boolean {
    return this.endedFlag
  }

  /** ARCHITECTURE §8 item 5: this gated surface's tool gate is not running for the session. */
  get gateInactive(): boolean {
    return this.delivery.gateInactive
  }

  /** Asks held for `peers_inbox` because the gate is inactive. */
  heldAsks(): number {
    return this.delivery.heldAsks()
  }

  get journal(): Promise<SessionJournal> {
    return this.journalReady.promise
  }

  roomName(roomId: string): string {
    return this.rooms.find((r) => r.room_id === roomId)?.name ?? this.roster.roomName(roomId) ?? roomId
  }

  myHandle(roomId: string): string | undefined {
    return this.rooms.find((r) => r.room_id === roomId)?.handle
  }

  sentAsk(askId: string): SentAsk | undefined {
    return this.sentAsks.get(askId)
  }

  rememberAsk(askId: string, ask: SentAsk): void {
    this.sentAsks = new Map(this.sentAsks).set(askId, ask)
  }

  isForMe(message: PeerMessage): boolean {
    return isForMe(this, message)
  }

  /** Unread journal entries this session should see (others' asks and replies are skipped). */
  async unread(): Promise<readonly JournalEntry[]> {
    const journal = await this.journal
    return journal.unread().filter((entry) => this.isForMe(entry.message as unknown as PeerMessage))
  }

  log(line: string): void {
    this.deps.log(line)
  }

  // ---- state changes from hooks and tools ----------------------------------------------------

  /** A lifecycle hook reached the bridge for this session (ONBOARDING §4: implicit register). */
  noteHook(): void {
    this.presence.noteHook()
  }

  setActivity(state: Activity): void {
    if (!this.presence.setActivity(state)) return
    if (state === 'busy') this.delivery.confirmHandedOut()
    this.changes.notify()
    if (state === 'idle') this.pump()
  }

  setModel(model: string): void {
    if (this.handle.view.card.model !== model) this.presence.setModel(model)
  }

  /** Updates the workspace realpath; returns true when it changed. */
  setWorkspace(path: string): boolean {
    if (this.workspacePath === path) return false
    this.workspacePath = path
    return true
  }

  beginListen(): void {
    this.presence.beginListen()
  }

  endListen(): void {
    this.presence.endListen()
  }

  /** Re-reads autojoin.json for this session (after open, a workspace change or `autojoin`). */
  async autojoin(identityKeys: readonly string[] = [this.localKey]): Promise<void> {
    const scope = {
      hub: this.deps.hub,
      agent: this.deps.descriptor.agentKind,
      localKey: this.localKey,
      workspace: this.workspacePath,
    }
    const entries = await autojoinEntries(this.deps.home, scope)
    if (entries.length === 0) return
    await applyAutojoin({
      ...scope,
      home: this.deps.home,
      session: this.handle,
      entries,
      identityKeys,
      log: this.deps.log,
    })
  }

  // ---- injection ------------------------------------------------------------------------------

  /**
   * Claims (asks) and hands out the next envelope through `channel`, journaling it as injected.
   * `inline`: the caller returns it to the agent itself (tool result, hook output), so it is final.
   */
  handOut(
    channel: InjectChannel,
    maxChars: number,
    options: HandOutOptions = {},
  ): Promise<HandOut<PeerMessage> | null> {
    return this.delivery.handOut(channel, maxChars, options)
  }

  /** Pushes pending envelopes when the injector can reach the idle session. */
  pump(): void {
    this.delivery.pump()
  }

  /** `msg.reply`; a reply to an already closed ask is a no-op (ARCHITECTURE §6.2). */
  async reply(
    askId: string,
    text: string,
    state: ReplyState,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<'sent' | 'closed'> {
    try {
      await this.handle.reply({ ask_id: askId, text, state, ...(meta ? { meta } : {}) })
    } catch (error) {
      if (!isPeersError(error, 'ask_closed')) throw error
      this.queue.markReplied(askId)
      return 'closed'
    }
    this.queue.markReplied(askId)
    await (await this.journal).setAskState(askId, state)
    return 'sent'
  }

  render(message: PeerMessage, maxChars: number): string {
    const askText = message.re ? this.sentAsks.get(message.re)?.text : undefined
    return buildEnvelope({
      message,
      roomName: this.roomName(message.room_id),
      sender: this.roster.sender(message.room_id, message.from?.handle, message.from?.member),
      maxChars,
      ...(askText ? { askText } : {}),
    }).text
  }

  // ---- inbound ---------------------------------------------------------------------------------

  enqueue(message: PeerMessage, replay: boolean): void {
    this.queue.enqueue(message, { replay })
    this.pump()
  }

  private serial(task: () => Promise<void>): void {
    this.work = this.work.then(task).catch((error: unknown) => this.deps.log(`session: ${String(error)}`))
  }

  /** Resolves when every queued inbound step and push has run. */
  async settled(): Promise<void> {
    await this.work
    await this.delivery.settled()
  }

  private subscribe(): readonly Unsubscribe[] {
    const h = this.handle
    const events = this.deps.events
    return [
      h.on('msg.new', (n) => this.serial(() => routeMessage(this, n.message, n.replay === true))),
      h.on('ask.updated', (n) => this.serial(() => routeAskUpdate(this, n))),
      h.on('presence.changed', (n) => this.roster.set(n.room_id, n.handle, n.card)),
      h.on('session.patched', () => {
        this.changes.notify()
        this.pump()
      }),
      h.on('room.removed', (n) => events.roomGone(this, n.room_id)),
      h.on('kicked', (n) => events.roomGone(this, n.room_id)),
      h.on('handle.renamed', (n) => events.handleRenamed(this, n.room_id, n.old, n.new)),
      h.onRoomLost((room) => events.roomGone(this, room.room_id)),
      this.queue.onChange(() => this.changes.notify()),
      // A push channel that became ready (late `codex queue` probe) delivers what was held.
      this.deps.injector.onTierChange?.(() => this.pump()) ?? (() => undefined),
    ]
  }

  // ---- shutdown --------------------------------------------------------------------------------

  /** Stops listening without closing the hub session (superseded or connection lost). */
  dispose(): void {
    this.endedFlag = true
    this.delivery.stop()
    this.presence.stop()
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.handle.dispose()
    this.changes.notify()
  }

  /** `session.close` (SessionEnd, bridge shutdown), then dispose. */
  async close(): Promise<void> {
    if (this.endedFlag) return
    await this.presence.flush()
    try {
      if (this.handle.view.status === 'open') await this.handle.close()
    } catch (error) {
      this.deps.log(`session.close failed: ${String(error)}`)
    }
    this.dispose()
  }
}
