/**
 * Hub client (PROTOCOL §4–§6): JSON-RPC over the global WebSocket with hello/welcome, request
 * correlation and timeouts, typed notifications, heartbeat, reconnect with backoff, resync hooks
 * (sessions re-open themselves) and same-`client_msg_id` retries of idempotent sends.
 */
import {
  type DecodedFrame,
  decodeFrame,
  type ErrorCode,
  encodeError,
  encodeNotification,
  encodeRequest,
  fromRpcError,
  isAdapterOutdated,
  type MethodName,
  type NotificationMap,
  type NotificationName,
  type ParamsOf,
  PeersError,
  PROTOCOL_VERSION,
  parseNotification,
  type ResultOf,
  toPeersError,
  UNAUTHORIZED_CLOSE_CODE,
  type Welcome,
} from '@agent-peers/protocol'
import { type Backoff, createBackoff } from '../util/backoff'
import { type Clock, systemClock, type TimerHandle } from '../util/clock'
import { Emitter, type Listener, type Unsubscribe } from '../util/emitter'
import { Heartbeat } from './heartbeat'
import { createCall, InFlight, type PendingCall } from './inflight'
import { RetryQueue } from './retry-queue'
import { closeError, defaultWebSocketFactory, openSocket, type WebSocketLike } from './socket'
import type {
  ClientState,
  HubClientOptions,
  LifecycleEvent,
  RequestOptions,
  ResyncContext,
  ResyncHook,
} from './types'
import { assertTransportAllowed, toWebSocketUrl } from './url'

const DEFAULT_TIMEOUT_MS = 30_000
const FATAL_CODES: ReadonlySet<ErrorCode> = new Set(['version_unsupported', 'unauthorized'])

export class HubClient {
  private readonly clock: Clock
  private readonly timeoutMs: number
  private readonly backoff: Backoff | undefined
  private readonly notifications = new Emitter<NotificationMap>()
  private readonly lifecycle = new Emitter<{ event: LifecycleEvent }>()
  private readonly inflight: InFlight
  private hooks: readonly ResyncHook[] = []
  private readonly retryQueue: RetryQueue
  private socket: WebSocketLike | undefined
  private heartbeat: Heartbeat | undefined
  private reconnectTimer: TimerHandle | undefined
  private endpoint: { readonly url: string; readonly token: string } | undefined
  private currentState: ClientState = 'idle'
  private currentWelcome: Welcome | undefined
  private everConnected = false
  private lastCloseCode: number | undefined

  constructor(private readonly options: HubClientOptions) {
    this.clock = options.clock ?? systemClock
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
    const reconnect = options.reconnect ?? true
    this.backoff =
      reconnect === false
        ? undefined
        : createBackoff(reconnect === true ? undefined : reconnect, options.random)
    this.inflight = new InFlight(this.clock)
    this.retryQueue = new RetryQueue(this.clock)
  }

  get state(): ClientState {
    return this.currentState
  }

  get welcome(): Welcome | undefined {
    return this.currentWelcome
  }

  /** True when the hub's `min_adapter` is newer than our adapter (sessions are marked outdated). */
  get outdated(): boolean {
    return isAdapterOutdated(this.options.bridge.adapter, this.currentWelcome?.min_adapter)
  }

  /** Connects, says hello and runs resync hooks. Rejects if this first attempt fails. */
  async connect(hubUrl: string, token: string): Promise<Welcome> {
    if (this.currentState !== 'idle')
      throw new PeersError('internal', `cannot connect while ${this.currentState}`)
    const url = toWebSocketUrl(hubUrl)
    assertTransportAllowed(url, this.options.insecure === true)
    this.endpoint = { url, token }
    try {
      return await this.establish(false, 0)
    } catch (error) {
      if (this.state === 'connecting') this.currentState = 'idle'
      throw error
    }
  }

  request<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    options: RequestOptions = {},
  ): Promise<ResultOf<M>> {
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs
      const call = createCall({ method, params, internal: false, timeoutMs, resolve, reject })
      if (this.currentState === 'connected') return this.dispatch(call)
      if (
        call.idempotent &&
        this.everConnected &&
        (this.state === 'connecting' || this.state === 'reconnecting')
      ) {
        this.retryQueue.push(call)
        return
      }
      const code: ErrorCode = this.currentState === 'closed' ? 'closed' : 'not_connected'
      reject(new PeersError(code, `cannot send ${method}: client is ${this.currentState}`))
    })
  }

  on<N extends NotificationName>(name: N, handler: Listener<NotificationMap[N]>): Unsubscribe {
    return this.notifications.on(name, handler)
  }

  onLifecycle(handler: Listener<LifecycleEvent>): Unsubscribe {
    return this.lifecycle.on('event', handler)
  }

  /** Hooks run in registration order after every successful hello, before `connected` is emitted. */
  onResync(hook: ResyncHook): Unsubscribe {
    this.hooks = [...this.hooks, hook]
    return () => {
      this.hooks = this.hooks.filter((h) => h !== hook)
    }
  }

  /** Sends `bye`, closes the socket and rejects everything outstanding with `closed`. */
  async close(reason = 'closed by client'): Promise<void> {
    if (this.currentState === 'closed') return
    const wasConnected = this.currentState === 'connected'
    this.currentState = 'closed'
    if (this.reconnectTimer !== undefined) this.clock.clearTimeout(this.reconnectTimer)
    const socket = this.socket
    if (socket) {
      if (wasConnected) this.trySend(socket, encodeNotification('bye', {}))
      this.handleClose(socket, 1000, reason)
      socket.close(1000, 'bye')
    }
    this.retryQueue.rejectAll('closed', 'client closed')
    this.lifecycle.emit('event', { type: 'closed', reason })
  }

  // ---- connection management ------------------------------------------------------------------

  private async establish(reconnected: boolean, attempt: number): Promise<Welcome> {
    const endpoint = this.endpoint
    if (!endpoint) throw new PeersError('not_connected', 'connect() was never called')
    this.currentState = 'connecting'
    this.lifecycle.emit('event', { type: 'connecting', url: endpoint.url, attempt })
    const socket = await openSocket({
      url: endpoint.url,
      headers: { Authorization: `Bearer ${endpoint.token}` },
      factory: this.options.webSocketFactory ?? defaultWebSocketFactory,
      timeoutMs: this.timeoutMs,
      setTimer: (fn, ms) => this.clock.setTimeout(fn, ms),
      clearTimer: (handle) => this.clock.clearTimeout(handle),
      handlers: {
        onMessage: (ws, data) => this.handleMessage(ws, data),
        onOpen: (ws) => {
          this.socket = ws
        },
        onClose: (ws, code, reason) => this.handleClose(ws, code, reason || 'socket closed'),
      },
    })
    if (this.currentState !== 'connecting') {
      this.dropSocket(socket, 'client closed')
      throw new PeersError('closed', 'client closed while connecting')
    }
    // The hub may close right after accepting (4401: token refused) before this line runs.
    if (this.socket !== socket) throw closeError(this.lastCloseCode, 'connection closed while connecting')
    try {
      const welcome = await this.handshake(socket, reconnected)
      this.currentState = 'connected'
      this.everConnected = true
      this.backoff?.reset()
      this.lifecycle.emit('event', { type: 'connected', welcome, reconnected })
      for (const call of this.retryQueue.take()) this.dispatch(call)
      return welcome
    } catch (error) {
      this.dropSocket(socket, 'handshake failed')
      throw error
    }
  }

  private async handshake(socket: WebSocketLike, reconnected: boolean): Promise<Welcome> {
    const welcome = await this.internalRequest('hello', {
      protocol: this.options.protocols ?? [PROTOCOL_VERSION],
      bridge: this.options.bridge,
    })
    this.currentWelcome = welcome
    this.heartbeat = new Heartbeat(this.clock, this.options.heartbeatMs ?? welcome.heartbeat_ms, {
      onPing: () => {
        // A failed ping needs no handling: the dead-socket timer decides when the link is gone.
        this.internalRequest('ping', {}).catch(() => undefined)
      },
      onDead: () => this.dropSocket(socket, 'heartbeat timeout'),
    })
    this.heartbeat.start()
    await this.runResync(reconnected)
    if (this.socket !== socket) throw new PeersError('disconnected', 'socket closed during resync')
    return welcome
  }

  private async runResync(reconnected: boolean): Promise<void> {
    const context: ResyncContext = {
      reconnected,
      request: (method, params) => this.internalRequest(method, params),
      remapSession: (oldId, newId) => this.retryQueue.remapSession(oldId, newId),
    }
    for (const hook of this.hooks) {
      try {
        await hook(context)
      } catch (error) {
        if (error instanceof PeersError && (error.code === 'disconnected' || error.code === 'closed'))
          throw error
        const wrapped =
          error instanceof PeersError
            ? error
            : new PeersError('internal', 'resync hook failed', undefined, { cause: error })
        this.lifecycle.emit('event', { type: 'error', error: wrapped })
      }
    }
  }

  /** Detaches first (so the close event Bun may fire synchronously is ignored), then closes. */
  private dropSocket(socket: WebSocketLike, reason: string): void {
    this.handleClose(socket, 4000, reason)
    try {
      socket.close(4000, reason)
    } catch {
      // the socket is already gone; handleClose above did the bookkeeping
    }
  }

  /**
   * Bookkeeping for a lost socket. A 4401 close means the hub refused or revoked the member token:
   * nothing is retried and the client closes for good instead of reconnecting.
   */
  private handleClose(socket: WebSocketLike, code: number, reason: string): void {
    if (socket !== this.socket) return
    this.socket = undefined
    this.lastCloseCode = code
    this.heartbeat?.stop()
    this.heartbeat = undefined
    const wasConnected = this.currentState === 'connected'
    const closing = this.currentState === 'closed'
    const refused = code === UNAUTHORIZED_CLOSE_CODE
    const canRetry = !closing && !refused && this.backoff !== undefined
    for (const call of this.inflight.drain()) {
      if (canRetry && call.idempotent && !call.internal) this.retryQueue.push(call)
      else call.reject(closeError(closing ? undefined : code, `${call.method}: connection lost (${reason})`))
    }
    if (closing) return
    this.lifecycle.emit('event', { type: 'disconnected', reason, code })
    if (!wasConnected) return
    if (refused) this.closeFatally(new PeersError('unauthorized', `the hub closed the connection: ${reason}`))
    else if (this.backoff) this.scheduleReconnect()
    else this.currentState = 'idle'
  }

  private closeFatally(error: PeersError): void {
    this.currentState = 'closed'
    this.retryQueue.rejectAll('closed', `reconnect refused: ${error.code}`)
    this.lifecycle.emit('event', { type: 'closed', reason: error.message, error })
  }

  private scheduleReconnect(error?: PeersError): void {
    const backoff = this.backoff
    if (!backoff || this.currentState === 'closed') return
    const attempt = backoff.attempt + 1
    const delayMs = backoff.next()
    this.currentState = 'reconnecting'
    const at = this.clock.now() + delayMs
    this.lifecycle.emit('event', { type: 'reconnecting', attempt, delayMs, at, ...(error ? { error } : {}) })
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.currentState !== 'reconnecting') return
      this.establish(true, attempt).catch((failure: unknown) => this.onReconnectFailed(failure))
    }, delayMs)
  }

  private onReconnectFailed(failure: unknown): void {
    if (this.currentState === 'closed') return
    const error = failure instanceof PeersError ? failure : new PeersError('disconnected', String(failure))
    if (FATAL_CODES.has(error.code)) this.closeFatally(error)
    else this.scheduleReconnect(error)
  }

  // ---- frames ------------------------------------------------------------------------------------

  private internalRequest<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return new Promise<ResultOf<M>>((resolve, reject) => {
      this.dispatch(
        createCall({ method, params, internal: true, timeoutMs: this.timeoutMs, resolve, reject }),
      )
    })
  }

  private dispatch(pending: PendingCall): void {
    const socket = this.socket
    if (!socket) {
      pending.reject(new PeersError('disconnected', `cannot send ${pending.method}: no connection`))
      return
    }
    const call = pending.firstSentAt === undefined ? { ...pending, firstSentAt: this.clock.now() } : pending
    const id = this.inflight.add(call)
    let frame: string
    try {
      frame = encodeRequest(id, call.method, call.params)
    } catch (error) {
      this.inflight.take(id)
      call.reject(toPeersError(error))
      return
    }
    if (!this.trySend(socket, frame)) this.dropSocket(socket, 'send failed')
  }

  private trySend(socket: WebSocketLike, frame: string): boolean {
    try {
      socket.send(frame)
      this.heartbeat?.noteSent()
      return true
    } catch {
      return false
    }
  }

  private handleMessage(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.socket) return
    this.heartbeat?.noteReceived()
    this.handleFrame(socket, decodeFrame(data))
  }

  private handleFrame(socket: WebSocketLike, frame: DecodedFrame): void {
    switch (frame.type) {
      case 'result':
        this.settle(frame.id, (call) => call.resolve(frame.result))
        break
      case 'error':
        this.settle(frame.id, (call) => call.reject(fromRpcError(frame.error)))
        break
      case 'notification':
        this.deliverNotification(frame.method, frame.params)
        break
      case 'request':
        this.trySend(
          socket,
          encodeError(frame.id, new PeersError('method_not_found', `method not found: ${frame.method}`)),
        )
        break
      case 'invalid':
        this.reportError(new PeersError('invalid_frame', `ignored frame: ${frame.error.message}`))
        break
    }
  }

  private settle(id: number | string | null, apply: (call: PendingCall) => void): void {
    const call = this.inflight.take(id)
    if (call) apply(call)
    else this.reportError(new PeersError('invalid_frame', `response for unknown request id ${String(id)}`))
  }

  private deliverNotification(method: string, params: unknown): void {
    const parsed = parseNotification(method, params)
    if (parsed.ok) {
      this.notifications.emit(parsed.name, parsed.params as NotificationMap[NotificationName])
      return
    }
    // §11: unknown notifications are ignored; malformed known ones are reported.
    if (parsed.reason === 'invalid') this.reportError(new PeersError('invalid_frame', parsed.message))
  }

  private reportError(error: PeersError): void {
    this.lifecycle.emit('event', { type: 'error', error })
  }
}
