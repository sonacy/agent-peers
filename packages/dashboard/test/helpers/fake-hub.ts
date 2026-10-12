/**
 * A fake member API: a fetch that routes `METHOD /path` to handlers and records every call, plus a
 * fake EventSource the tests drive by hand. No network, no real hub.
 */
import type { EventSourceLike } from '../../src/live/stream'

export interface Call {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly credentials: RequestCredentials | undefined
}

/** A function of the call, or a fixed JSON body. */
export type Handler = ((call: Call) => unknown) | Record<string, unknown>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function apiError(code: string, status: number, message = code, retryAfterMs?: number): Response {
  const extra = retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }
  return json({ error: { code, message, ...extra } }, status)
}

export interface FakeHub {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly calls: Call[]
  readonly on: (route: string, handler: Handler) => void
  readonly callsTo: (route: string) => Call[]
}

/** Routes are `GET /v0/me` style; the query string is ignored for matching. Unknown routes 404. */
export function createFakeHub(routes: Record<string, Handler> = {}): FakeHub {
  const table = new Map(Object.entries(routes))
  const calls: Call[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const path = input
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { method, path, body, credentials: init?.credentials }
    calls.push(call)
    const handler = table.get(`${method} ${path.split('?')[0]}`)
    if (handler === undefined) return apiError('method_not_found', 404)
    const result = typeof handler === 'function' ? await handler(call) : handler
    return result instanceof Response ? result : json(result)
  }
  return {
    fetch,
    calls,
    on: (route, handler) => table.set(route, handler),
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path.split('?')[0]}` === route),
  }
}

export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, ((event: Event) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  static reset(): void {
    FakeEventSource.instances = []
  }

  static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1)
    if (last === undefined) throw new Error('no EventSource created')
    return last
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open(): void {
    this.dispatch('open', new Event('open'))
  }

  fail(): void {
    this.dispatch('error', new Event('error'))
  }

  emit(name: string, data: unknown): void {
    const raw = typeof data === 'string' ? data : JSON.stringify(data)
    this.dispatch(name, new MessageEvent(name, { data: raw }))
  }
}

export const createFakeSource = (url: string): EventSourceLike => new FakeEventSource(url)
