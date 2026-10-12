/**
 * Per-session API over a HubClient. Keeps an immutable SessionView up to date from request results
 * and session-scoped notifications, and re-opens itself (latest card, same local_key) after a
 * reconnect (PROTOCOL §4, §5.1). The `session.open` result is authoritative: a remembered room it
 * no longer lists was removed while the bridge was offline and is reported, never re-joined.
 */

import {
  type CardInput,
  type NotificationMap,
  type NotificationName,
  type ParamsMap,
  PeersError,
  type ResultOf,
  type SessionPatch,
  ulid,
} from '@agent-peers/protocol'
import type { HubClient } from '../client/hub-client'
import type { ResyncContext } from '../client/types'
import type { Clock } from '../util/clock'
import { systemClock } from '../util/clock'
import { Emitter, type Listener, type Unsubscribe } from '../util/emitter'
import {
  type AskInput,
  askParams,
  type ChatInput,
  chatParams,
  type ProgressInput,
  progressParams,
  type ReplyInput,
  replyParams,
} from './messages'
import {
  addRoom,
  applyOpenResult,
  applyRenameResult,
  initialView,
  patchCard,
  removeKnock,
  removeRoom,
  renameHandle,
  type SessionRoom,
  type SessionView,
  upsertKnock,
  withStatus,
} from './view'

export interface SessionHandleOptions {
  readonly localKey: string
  readonly card: CardInput
  /** The local_key this session replaces (`/clear`, `/resume`, bootstrap → real session). */
  readonly supersedes?: string
  readonly clock?: Clock
  /** `client_msg_id` generator (default ULID). */
  readonly newId?: () => string
}

export type JoinTarget = (
  | { readonly room_id: string }
  | { readonly room_name: string }
  | { readonly invite_code: string }
) & { readonly handle?: string; readonly takeover?: boolean }

type HandleEvents = { change: SessionView; roomLost: SessionRoom }

export class SessionHandle {
  private current: SessionView
  private readonly events = new Emitter<HandleEvents>()
  private readonly newId: () => string
  private readonly subscriptions: readonly Unsubscribe[]

  constructor(
    private readonly client: HubClient,
    options: SessionHandleOptions,
  ) {
    const clock = options.clock ?? systemClock
    this.newId = options.newId ?? (() => ulid(clock.now()))
    this.current = initialView(options.localKey, options.card, options.supersedes)
    this.subscriptions = [client.onResync((ctx) => this.resync(ctx)), ...this.subscribeNotifications()]
  }

  get view(): SessionView {
    return this.current
  }

  get sessionId(): string {
    const id = this.current.sessionId
    if (!id || this.current.status !== 'open') {
      throw new PeersError('session_not_open', `session ${this.current.localKey} is ${this.current.status}`)
    }
    return id
  }

  onChange(listener: Listener<SessionView>): Unsubscribe {
    return this.events.on('change', listener)
  }

  /**
   * A room this session was in is gone after a reconnect: removed, kicked, exited or dissolved
   * while the bridge was offline, so the `room.removed` notification never arrived. The bridge
   * should drop it from auto-join instead of joining it again.
   */
  onRoomLost(listener: Listener<SessionRoom>): Unsubscribe {
    return this.events.on('roomLost', listener)
  }

  /** Session-scoped notifications for this session only. */
  on<N extends NotificationName>(name: N, handler: Listener<NotificationMap[N]>): Unsubscribe {
    return this.client.on(name, (payload) => {
      if (payload.session_id === this.current.sessionId) handler(payload)
    })
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  async open(): Promise<SessionView> {
    const { localKey, card, supersedes } = this.current
    this.set(withStatus(this.current, 'opening'))
    try {
      const result = await this.client.request('session.open', {
        local_key: localKey,
        card,
        ...(supersedes ? { supersedes } : {}),
      })
      this.set({ ...applyOpenResult(this.current, result), supersedes: undefined })
      return this.current
    } catch (error) {
      this.set(withStatus(this.current, 'new'))
      throw error
    }
  }

  /** Closes the session. While disconnected the close is deferred to the next resync (§4). */
  async close(): Promise<void> {
    const sessionId = this.sessionId
    this.set(withStatus(this.current, 'closing'))
    if (this.client.state !== 'connected') return
    await this.client.request('session.close', { session_id: sessionId })
    this.finishClose()
  }

  /** Stops listening to the client. Does not close the session on the hub. */
  dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.events.clear()
  }

  async update(patch: SessionPatch): Promise<void> {
    await this.client.request('session.update', { session_id: this.sessionId, ...patch })
    this.set(patchCard(this.current, patch))
  }

  async rename(change: {
    title?: string
    handle?: string
    room_id?: string
  }): Promise<ResultOf<'session.rename'>> {
    const result = await this.client.request('session.rename', { session_id: this.sessionId, ...change })
    this.set(applyRenameResult(this.current, result))
    return result
  }

  // ---- rooms ---------------------------------------------------------------------------------------

  async join(target: JoinTarget): Promise<ResultOf<'room.join'>> {
    const result = await this.client.request('room.join', { session_id: this.sessionId, ...target })
    const name = result.room.name
    const room = { room_id: result.room.room_id, handle: result.handle }
    this.set(addRoom(this.current, name === undefined ? room : { ...room, name }))
    return result
  }

  async leave(roomId: string): Promise<void> {
    await this.client.request('room.leave', { session_id: this.sessionId, room_id: roomId })
    this.set(removeRoom(this.current, roomId))
  }

  async exit(roomId: string): Promise<void> {
    await this.client.request('room.exit', { session_id: this.sessionId, room_id: roomId })
    this.set(removeRoom(this.current, roomId))
  }

  async removeSession(roomId: string, targetSessionId: string): Promise<void> {
    const sessionId = this.sessionId
    await this.client.request('room.remove_session', {
      session_id: sessionId,
      room_id: roomId,
      target_session_id: targetSessionId,
    })
    if (targetSessionId === sessionId) this.set(removeRoom(this.current, roomId))
  }

  async list(): Promise<ResultOf<'room.list'>> {
    return this.client.request('room.list', { session_id: this.sessionId })
  }

  async peers(roomId?: string): Promise<ResultOf<'peers.list'>> {
    return this.client.request('peers.list', {
      session_id: this.sessionId,
      ...(roomId ? { room_id: roomId } : {}),
    })
  }

  async search(q: string): Promise<ResultOf<'room.search'>> {
    return this.client.request('room.search', { session_id: this.sessionId, q })
  }

  async knock(roomId: string, note?: string): Promise<ResultOf<'room.knock'>> {
    const params = { session_id: this.sessionId, room_id: roomId, ...(note === undefined ? {} : { note }) }
    const result = await this.client.request('room.knock', params)
    this.set(upsertKnock(this.current, { knock_id: result.knock_id, room_id: roomId, state: 'pending' }))
    return result
  }

  async withdraw(knockId: string): Promise<void> {
    await this.client.request('knock.withdraw', { session_id: this.sessionId, knock_id: knockId })
    this.set(removeKnock(this.current, knockId))
  }

  async dashboardLogin(): Promise<ResultOf<'dashboard.login'>> {
    return this.client.request('dashboard.login', { session_id: this.sessionId })
  }

  // ---- messages ------------------------------------------------------------------------------------

  async send(input: ChatInput): Promise<ResultOf<'msg.send'>> {
    return this.client.request('msg.send', chatParams(this.sessionId, input, this.newId))
  }

  async ask(input: AskInput): Promise<ResultOf<'msg.send'>> {
    return this.client.request('msg.send', askParams(this.sessionId, input, this.newId))
  }

  async reply(input: ReplyInput): Promise<ResultOf<'msg.reply'>> {
    return this.client.request('msg.reply', replyParams(this.sessionId, input, this.newId))
  }

  async progress(input: ProgressInput): Promise<ResultOf<'msg.progress'>> {
    return this.client.request('msg.progress', progressParams(this.sessionId, input, this.newId))
  }

  async claim(askId: string): Promise<ResultOf<'ask.claim'>> {
    return this.client.request('ask.claim', { session_id: this.sessionId, ask_id: askId })
  }

  async cancel(askId: string): Promise<void> {
    await this.client.request('ask.cancel', { session_id: this.sessionId, ask_id: askId })
  }

  async getAsk(askId: string): Promise<ResultOf<'ask.get'>> {
    return this.client.request('ask.get', { session_id: this.sessionId, ask_id: askId })
  }

  async ack(roomId: string, seq: number): Promise<void> {
    await this.client.request('msg.ack', { session_id: this.sessionId, room_id: roomId, seq })
  }

  async history(
    roomId: string,
    options: { before_seq?: number; limit?: number } = {},
  ): Promise<ResultOf<'msg.history'>> {
    const params: ParamsMap['msg.history'] = { session_id: this.sessionId, room_id: roomId, ...options }
    return this.client.request('msg.history', params)
  }

  // ---- internals -----------------------------------------------------------------------------------

  private set(next: SessionView): void {
    if (next === this.current) return
    this.current = next
    this.events.emit('change', next)
  }

  private finishClose(): void {
    this.set(withStatus(this.current, 'closed'))
  }

  private subscribeNotifications(): readonly Unsubscribe[] {
    return [
      this.on('handle.renamed', (n) => this.set(renameHandle(this.current, n.room_id, n.old, n.new))),
      this.on('handle.lost', (n) => this.set(removeRoom(this.current, n.room_id))),
      this.on('room.removed', (n) => this.set(removeRoom(this.current, n.room_id))),
      this.on('kicked', (n) => this.set(removeRoom(this.current, n.room_id))),
      this.on('room.closed', (n) => {
        if (n.room_id) this.set(removeRoom(this.current, n.room_id))
      }),
      this.on('session.patched', (n) =>
        this.set(patchCard(this.current, { accepting: n.accepting, title: n.title })),
      ),
      this.on('knock.updated', (n) =>
        this.set(upsertKnock(this.current, { knock_id: n.knock_id, room_id: n.room_id, state: n.state })),
      ),
    ]
  }

  private async resync(ctx: ResyncContext): Promise<void> {
    const view = this.current
    if (view.status === 'closing' && view.sessionId) {
      await this.closeOnResync(ctx, view)
      return
    }
    if (view.status !== 'open' || !ctx.reconnected) return
    const remembered = view.rooms
    const result = await ctx.request('session.open', { local_key: view.localKey, card: view.card })
    if (view.sessionId && view.sessionId !== result.session_id)
      ctx.remapSession(view.sessionId, result.session_id)
    this.set(applyOpenResult(this.current, result))
    this.reportLostRooms(remembered)
  }

  private reportLostRooms(remembered: readonly SessionRoom[]): void {
    const present = new Set([...this.current.rooms, ...this.current.heldRooms].map((r) => r.room_id))
    for (const room of remembered.filter((r) => !present.has(r.room_id))) this.events.emit('roomLost', room)
  }

  /**
   * A close deferred while disconnected (§4): `session.close` must name a session on the calling
   * connection (§6.4), so the session is reattached first and then closed.
   */
  private async closeOnResync(ctx: ResyncContext, view: SessionView): Promise<void> {
    const reattached = await ctx.request('session.open', { local_key: view.localKey, card: view.card })
    await ctx.request('session.close', { session_id: reattached.session_id })
    this.finishClose()
  }
}
