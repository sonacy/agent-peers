/**
 * Server-sent events for the dashboards (DASHBOARD §11): `GET /v0/me/events` (scoped to what the
 * member may see) and `GET /v0/admin/events` (everything). Frames come from the hub's EventBus.
 */
import { encodeMemberEvent } from '@agent-peers/protocol'
import type { Clock, TimerHandle } from '../clock'
import type { HubEvent } from '../services/events'

export interface StreamRegistry {
  /** Registers an open stream's closer; returns the unregister function. */
  add(close: () => void): () => void
  /** Ends every open stream (hub stop). */
  closeAll(): void
}

export function createStreamRegistry(): StreamRegistry {
  let closers: ReadonlySet<() => void> = new Set()
  return {
    add(close) {
      closers = new Set([...closers, close])
      return () => {
        closers = new Set([...closers].filter((c) => c !== close))
      }
    },
    closeAll() {
      for (const close of closers) close()
      closers = new Set()
    },
  }
}

export interface SseOptions {
  readonly clock: Clock
  readonly keepaliveMs: number
  readonly registry: StreamRegistry
  /** Starts delivering frames to `write`; returns the unsubscribe function. */
  readonly subscribe: (write: (frame: string) => void) => () => void
  /** Checked before each frame; returning false ends the stream (logout, expiry, rotation). */
  readonly alive?: () => boolean
}

const RETRY_MS = 3000
const encoder = new TextEncoder()

export function eventFrame(event: HubEvent, id: number): string {
  return encodeMemberEvent(event.name, event.data, String(id))
}

/** A frame writer bound to one stream controller, with its cleanup. */
function createStream(options: SseOptions): ReadableStream<Uint8Array> {
  const { clock, keepaliveMs, registry } = options
  let closed = false
  let timer: TimerHandle | undefined
  let unsubscribe: () => void = () => undefined
  let unregister: () => void = () => undefined
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined

  const cleanup = () => {
    if (closed) return
    closed = true
    if (timer !== undefined) clock.clearTimeout(timer)
    unsubscribe()
    unregister()
  }
  const close = () => {
    cleanup()
    try {
      controller?.close()
    } catch {
      // the client already went away
    }
  }
  const write = (frame: string) => {
    if (closed) return
    if (options.alive && !options.alive()) return close()
    try {
      controller?.enqueue(encoder.encode(frame))
    } catch {
      cleanup()
    }
  }
  const keepalive = () => {
    timer = clock.setTimeout(() => {
      write(': keepalive\n\n')
      if (!closed) keepalive()
    }, keepaliveMs)
  }

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      ctrl.enqueue(encoder.encode(`retry: ${RETRY_MS}\n: connected\n\n`))
      unsubscribe = options.subscribe(write)
      unregister = registry.add(close)
      keepalive()
    },
    cancel() {
      cleanup()
    },
  })
}

export function sseResponse(options: SseOptions): Response {
  return new Response(createStream(options), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}
