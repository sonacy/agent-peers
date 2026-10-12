/** Per-connection state for one bridge socket (§1, §4). */
import type { ServerWebSocket } from 'bun'
import type { TimerHandle } from '../clock'

export interface SocketData {
  readonly connId: string
  readonly memberId: string
  /** The upgrade carried no valid member token: the socket is closed with 4401 as soon as it opens. */
  readonly unauthorized?: true
}

export type HubSocket = ServerWebSocket<SocketData>

export interface BridgeHello {
  readonly agentKind: string
  readonly adapter: string
  readonly host: string
  readonly protocol: string
}

/**
 * Mutable bookkeeping owned by the WS layer: which sessions ride on the socket, the hello result,
 * heartbeat timing and the serial request queue that keeps each connection's requests in order.
 */
export class Connection {
  readonly id: string
  readonly memberId: string
  readonly sessions = new Set<string>()
  hello: BridgeHello | undefined
  outdated = false
  /** `bye` was received or the hub closed the socket on purpose: no stale transition on close. */
  closing = false
  stale = false
  lastFrameAt: number
  staleTimer: TimerHandle | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly ws: HubSocket,
    now: number,
  ) {
    this.id = ws.data.connId
    this.memberId = ws.data.memberId
    this.lastFrameAt = now
  }

  /** Runs tasks one at a time, in arrival order. */
  enqueue(task: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  send(frame: string): void {
    if (this.ws.readyState === 1) this.ws.send(frame)
  }

  close(code: number, reason: string): void {
    this.closing = true
    try {
      this.ws.close(code, reason)
    } catch {
      // already closed: nothing left to release
    }
  }
}

export const sessionTopic = (sessionId: string): string => `session:${sessionId}`
