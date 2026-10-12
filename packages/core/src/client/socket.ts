/** WebSocket abstraction so tests can inject a factory; the default uses Bun's global WebSocket. */
import { PeersError, UNAUTHORIZED_CLOSE_CODE } from '@agent-peers/protocol'

export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'error', listener: (event: Event) => void): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(type: 'close', listener: (event: CloseEvent) => void): void
}

export type WebSocketFactory = (url: string, headers: Readonly<Record<string, string>>) => WebSocketLike

/**
 * Bun's WebSocket accepts `headers`, so the member token travels in `Authorization` (PROTOCOL §4).
 * The DOM lib's constructor typing hides Bun's options overload, hence the narrowed constructor type.
 */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocketLike

export const defaultWebSocketFactory: WebSocketFactory = (url, headers) =>
  new BunWebSocket(url, { headers: { ...headers } })

export interface SocketHandlers {
  /** Called synchronously on open, before the promise settles, so an immediate close is not missed. */
  readonly onOpen?: (socket: WebSocketLike) => void
  readonly onMessage: (socket: WebSocketLike, data: unknown) => void
  readonly onClose: (socket: WebSocketLike, code: number, reason: string) => void
}

export interface OpenSocketOptions {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly factory: WebSocketFactory
  readonly timeoutMs: number
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  readonly handlers: SocketHandlers
}

/**
 * The error for a lost socket: `unauthorized` for a 4401 close (bad or revoked token), `closed` when
 * there is no code (the client closed it), `disconnected` otherwise.
 */
export function closeError(code: number | undefined, message: string): PeersError {
  if (code === undefined) return new PeersError('closed', message)
  return new PeersError(code === UNAUTHORIZED_CLOSE_CODE ? 'unauthorized' : 'disconnected', message)
}

/**
 * Opens a socket and resolves once it is open. Messages and closes after that go to `handlers`.
 * A close with 4401 (bad or revoked token) rejects with `unauthorized`, which callers treat as fatal.
 */
export function openSocket(options: OpenSocketOptions): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    let opened = false
    let settled = false
    let socket: WebSocketLike
    try {
      socket = options.factory(options.url, options.headers)
    } catch (error) {
      reject(new PeersError('disconnected', `cannot open ${options.url}`, undefined, { cause: error }))
      return
    }
    const fail = (message: string, code: 'disconnected' | 'unauthorized' = 'disconnected') => {
      if (settled) return
      settled = true
      options.clearTimer(timer)
      try {
        socket.close()
      } catch {
        // already closed: nothing to release
      }
      reject(new PeersError(code, message))
    }
    const timer = options.setTimer(() => fail(`timed out connecting to ${options.url}`), options.timeoutMs)
    socket.addEventListener('open', () => {
      if (settled) return
      opened = true
      settled = true
      options.clearTimer(timer)
      options.handlers.onOpen?.(socket)
      resolve(socket)
    })
    socket.addEventListener('error', () => fail(`connection to ${options.url} failed`))
    socket.addEventListener('message', (event) => {
      if (opened) options.handlers.onMessage(socket, event.data)
    })
    socket.addEventListener('close', (event) => {
      if (opened) options.handlers.onClose(socket, event.code, event.reason)
      else if (event.code === UNAUTHORIZED_CLOSE_CODE)
        fail('the hub refused the member token', 'unauthorized')
      else fail(`connection to ${options.url} closed (${event.code})`)
    })
  })
}
