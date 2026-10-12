/** Test support for the HTTP layer: a real hub on port 0, signed-in members and a small fetch client. */
import type { HttpOptions } from '../../src/http/types'
import type { CreateHubOptions } from '../../src/hub'
import { type RunningHub, startHub } from '../helpers/hub'
import type { TestClient } from '../helpers/ws-client'

export interface HttpHub extends RunningHub {
  readonly base: string
  readonly adminBase: string
}

export async function startHttpHub(
  options: CreateHubOptions & { http?: HttpOptions } = {},
): Promise<HttpHub> {
  const running = await startHub({ bootstrapDefaultRoom: false, ...options })
  return {
    ...running,
    base: `http://127.0.0.1:${running.info.publicPort}`,
    adminBase: `http://127.0.0.1:${running.info.adminPort}`,
  }
}

export interface Caller {
  get(path: string, init?: RequestInit): Promise<Response>
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>
  patch(path: string, body?: unknown, init?: RequestInit): Promise<Response>
  del(path: string, init?: RequestInit): Promise<Response>
}

/** A browser-like caller: same-origin Origin header, JSON bodies and an optional cookie. */
export function caller(base: string, cookie?: string, origin: string | null = base): Caller {
  const headers = (init?: RequestInit, json = false): Headers => {
    const h = new Headers(init?.headers)
    if (cookie !== undefined) h.set('cookie', cookie)
    if (origin !== null && !h.has('origin')) h.set('origin', origin)
    if (json && !h.has('content-type')) h.set('content-type', 'application/json')
    return h
  }
  const send = (method: string, path: string, body: unknown, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      method,
      headers: headers(init, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    })
  return {
    get: (path, init) => fetch(`${base}${path}`, { ...init, headers: headers(init), redirect: 'manual' }),
    post: (path, body, init) => send('POST', path, body, init),
    patch: (path, body, init) => send('PATCH', path, body, init),
    del: (path, init) => send('DELETE', path, undefined, init),
  }
}

/** `name=value` from a Set-Cookie header. */
export function cookiePair(res: Response): string {
  const header = res.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

export interface SignedIn {
  readonly name: string
  readonly memberId: string
  readonly token: string
  readonly client: TestClient
  readonly sessionId: string
  readonly cookie: string
  readonly api: Caller
}

/** Logs in through the real flow: WS `dashboard.login`, then the Continue POST with Origin. */
export async function signIn(h: HttpHub, name: string, localKey = `${name}-1`): Promise<SignedIn> {
  const issued = h.hub.services.members.create(name)
  const client = await h.client(issued.token)
  const { session_id } = await client.open(localKey)
  const link = await client.request<{ code: string; url: string }>('dashboard.login', { session_id })
  const res = await caller(h.base).post('/app/login', { code: link.code })
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  const cookie = cookiePair(res)
  return {
    name,
    memberId: issued.member.id,
    token: issued.token,
    client,
    sessionId: session_id,
    cookie,
    api: caller(h.base, cookie),
  }
}

export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

export async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } }
  return body.error?.code
}

export interface SseEvent {
  readonly event: string
  readonly data: string
}

export interface EventReader {
  /** Reads until `predicate` holds for everything read so far, or the timeout passes. */
  until(predicate: (events: readonly SseEvent[]) => boolean, timeoutMs?: number): Promise<readonly SseEvent[]>
  close(): Promise<void>
}

function parseFrame(frame: string): SseEvent | undefined {
  const event = /^event: (.*)$/m.exec(frame)?.[1]
  const data = /^data: (.*)$/m.exec(frame)?.[1]
  if (event !== undefined && data !== undefined) return { event, data }
  const comment = frame.split('\n').find((line) => line.startsWith(':'))
  return comment === undefined ? undefined : { event: 'comment', data: comment }
}

/** Incrementally reads SSE frames from one streaming response. */
export function openEvents(res: Response): EventReader {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ''
  let ended = false
  const pump = async (deadline: number): Promise<boolean> => {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))),
    ])
    if (chunk === 'timeout') return false
    if (chunk.done) {
      ended = true
      return false
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const parsed = parseFrame(frame)
      if (parsed) events.push(parsed)
    }
    return true
  }
  return {
    async until(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (!ended && !predicate(events) && Date.now() < deadline) {
        if (!(await pump(deadline))) break
      }
      return [...events]
    },
    close: () => reader.cancel().catch(() => undefined),
  }
}

/** Reads SSE frames until `predicate` matches or the timeout passes, then closes the stream. */
export async function readEvents(
  res: Response,
  predicate: (events: readonly SseEvent[]) => boolean,
  timeoutMs = 2000,
): Promise<readonly SseEvent[]> {
  const reader = openEvents(res)
  try {
    return await reader.until(predicate, timeoutMs)
  } finally {
    await reader.close()
  }
}
