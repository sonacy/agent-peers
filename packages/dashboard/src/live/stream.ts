/**
 * The live connection to the hub (DASHBOARD §7, §11): an EventSource on `/v0/me/events` that
 * reconnects with backoff (1s → 30s) and reports a Core-pill state. Framework-free so it can be
 * tested with a fake EventSource and fake timers.
 */
import { MEMBER_EVENTS_PATH } from '@agent-peers/protocol'
import type { CoreState } from '../components/core-pill'
import { backoffDelay } from './backoff'
import { MEMBER_EVENT_NAMES, type MemberEvent, parseEvent } from './events'

/** The parts of EventSource the stream uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

export type CreateEventSource = (url: string) => EventSourceLike

export interface LiveStatus {
  readonly state: CoreState
  /** Consecutive failed attempts since the last successful open. */
  readonly failures: number
  readonly lastError?: string
  /** Epoch ms of the next reconnect attempt while disconnected. */
  readonly nextRetryAt?: number
}

export interface Timers {
  readonly set: (fn: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
  readonly now: () => number
}

export interface StreamOptions {
  readonly url?: string
  readonly createSource: CreateEventSource
  readonly onEvent: (event: MemberEvent) => void
  readonly onStatus: (status: LiveStatus) => void
  /** Called when the stream comes back after a gap: missed events mean everything should refetch. */
  readonly onResync?: () => void
  /**
   * Called on every failed attempt. EventSource can't see the status code, so an expired session
   * looks exactly like a dead hub; the caller re-checks who is signed in (a 401 there signs out).
   */
  readonly onFailure?: (failures: number) => void
  readonly timers?: Timers
}

export interface StreamHandle {
  /** Reconnect now instead of waiting for the backoff timer (现在重试). */
  readonly retryNow: () => void
  readonly close: () => void
}

const DEFAULT_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export const INITIAL_STATUS: LiveStatus = { state: 'reconnecting', failures: 0 }

function errorText(): string {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return offline ? '这台电脑断网了' : '事件流断开了，Core 可能停了或者重启了'
}

export function connectMemberEvents(options: StreamOptions): StreamHandle {
  const timers = options.timers ?? DEFAULT_TIMERS
  const url = options.url ?? MEMBER_EVENTS_PATH
  let source: EventSourceLike | undefined
  let timer: unknown
  let failures = 0
  let closed = false
  let hadGap = false

  const report = (status: LiveStatus) => {
    if (!closed) options.onStatus(status)
  }

  const onFailure = () => {
    source?.close()
    source = undefined
    failures += 1
    hadGap = true
    const delay = backoffDelay(failures)
    const nextRetryAt = timers.now() + delay
    // One blip shows 正在连 Core…; a second failure in a row turns the pill red (§7).
    report({
      state: failures > 1 ? 'disconnected' : 'reconnecting',
      failures,
      lastError: errorText(),
      nextRetryAt,
    })
    timer = timers.set(open, delay)
    if (!closed) options.onFailure?.(failures)
  }

  const onOpen = () => {
    failures = 0
    report({ state: 'connected', failures: 0 })
    if (hadGap) {
      hadGap = false
      options.onResync?.()
    }
  }

  function open(): void {
    if (closed) return
    timer = undefined
    let next: EventSourceLike
    try {
      next = options.createSource(url)
    } catch {
      onFailure()
      return
    }
    source = next
    next.addEventListener('open', onOpen)
    next.addEventListener('error', () => {
      if (source === next) onFailure()
    })
    for (const name of MEMBER_EVENT_NAMES) {
      next.addEventListener(name, (event) => {
        const data = (event as MessageEvent<unknown>).data
        const parsed = typeof data === 'string' ? parseEvent(name, data) : undefined
        if (parsed !== undefined && !closed) options.onEvent(parsed)
      })
    }
  }

  open()

  return {
    retryNow: () => {
      if (closed || source !== undefined) return
      if (timer !== undefined) timers.clear(timer)
      report({ state: 'reconnecting', failures })
      open()
    },
    close: () => {
      closed = true
      if (timer !== undefined) timers.clear(timer)
      source?.close()
      source = undefined
    },
  }
}

/** The browser EventSource with cookies; undefined where EventSource doesn't exist. */
export function browserEventSource(): CreateEventSource | undefined {
  if (typeof EventSource === 'undefined') return undefined
  return (url) => new EventSource(url, { withCredentials: true })
}
