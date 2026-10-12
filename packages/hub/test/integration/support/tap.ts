/**
 * A WebSocket factory for the real HubClient that keeps a handle on the raw socket, so tests can
 * simulate a crash (unclean close) or lose one response frame in flight.
 */
import type { WebSocketFactory, WebSocketLike } from '@agent-peers/core'
import { defaultWebSocketFactory } from '@agent-peers/core'

export interface SentFrame {
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
}

type AnyListener = ((event: Event) => void) | ((event: MessageEvent) => void) | ((event: CloseEvent) => void)

/** Wraps one real socket; outgoing frames are recorded and incoming ones can be swallowed. */
class TappedSocket implements WebSocketLike {
  constructor(
    readonly inner: WebSocketLike,
    private readonly tap: SocketTap,
  ) {}

  send(data: string): void {
    this.tap.recordSent(data)
    this.inner.send(data)
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason)
  }

  addEventListener(type: 'open' | 'error', listener: (event: Event) => void): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(type: 'close', listener: (event: CloseEvent) => void): void
  addEventListener(type: 'open' | 'error' | 'message' | 'close', listener: AnyListener): void {
    if (type === 'message') {
      const onMessage = listener as (event: MessageEvent) => void
      this.inner.addEventListener('message', (event) => {
        if (!this.tap.swallow(this, event.data)) onMessage(event)
      })
      return
    }
    if (type === 'close') this.inner.addEventListener('close', listener as (event: CloseEvent) => void)
    else this.inner.addEventListener(type, listener as (event: Event) => void)
  }
}

function parseFrame(data: unknown): SentFrame | undefined {
  try {
    const value: unknown = JSON.parse(String(data))
    return typeof value === 'object' && value !== null ? (value as SentFrame) : undefined
  } catch {
    return undefined
  }
}

export class SocketTap {
  private sentFrames: readonly SentFrame[] = []
  private sockets: readonly TappedSocket[] = []
  private dropMethod: string | undefined
  private dropId: number | string | undefined

  readonly factory: WebSocketFactory = (url, headers) => {
    const socket = new TappedSocket(defaultWebSocketFactory(url, headers), this)
    this.sockets = [...this.sockets, socket]
    return socket
  }

  get sent(): readonly SentFrame[] {
    return this.sentFrames
  }

  get connections(): number {
    return this.sockets.length
  }

  sentOf(method: string): readonly SentFrame[] {
    return this.sentFrames.filter((f) => f.method === method)
  }

  /** Closes the current raw socket without `bye`: the hub sees an unclean close (§5.1). */
  crash(code = 4999): void {
    this.sockets.at(-1)?.inner.close(code, 'simulated crash')
  }

  /**
   * The next request of `method` reaches the hub, but its response is lost and the socket drops,
   * as on a network failure between the hub's commit and the reply.
   */
  loseNextResponseTo(method: string): void {
    this.dropMethod = method
    this.dropId = undefined
  }

  recordSent(data: string): void {
    const frame = parseFrame(data)
    if (!frame) return
    this.sentFrames = [...this.sentFrames, frame]
    if (this.dropMethod !== undefined && frame.method === this.dropMethod && frame.id !== undefined) {
      this.dropMethod = undefined
      this.dropId = frame.id
    }
  }

  /** True when the frame was swallowed (and the socket dropped). */
  swallow(socket: TappedSocket, data: unknown): boolean {
    if (this.dropId === undefined) return false
    const frame = parseFrame(data)
    if (!frame || frame.method !== undefined || frame.id !== this.dropId) return false
    this.dropId = undefined
    socket.inner.close(4000, 'simulated network drop')
    return true
  }
}
