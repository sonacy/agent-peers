/** Minimal JSON-RPC test client over Bun's global WebSocket. */
import { PROTOCOL_VERSION } from '@agent-peers/protocol'

export interface RpcError {
  readonly code: number
  readonly message: string
  readonly data?: { readonly code?: string } & Record<string, unknown>
}

export interface Frame {
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly id?: number | string | null
  readonly result?: unknown
  readonly error?: RpcError
}

export class RpcFailure extends Error {
  constructor(readonly error: RpcError) {
    super(error.message)
  }
  get code(): string | undefined {
    return this.error.data?.code
  }
}

type Waiter = { match: (f: Frame) => boolean; resolve: (f: Frame) => void }

export class TestClient {
  readonly frames: Frame[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  private nextId = 1
  private waiters: Waiter[] = []
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
    })
    ws.addEventListener('message', (e) => this.onFrame(JSON.parse(String(e.data)) as Frame))
  }

  static async connect(url: string, token: string): Promise<TestClient> {
    const Ctor = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket
    const ws = new Ctor(url, { headers: { Authorization: `Bearer ${token}` } })
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('connect failed')))
    })
    return new TestClient(ws)
  }

  private onFrame(frame: Frame): void {
    this.frames.push(frame)
    if (typeof frame.id === 'number' && this.pending.has(frame.id)) {
      const call = this.pending.get(frame.id)
      this.pending.delete(frame.id)
      if (frame.error) call?.reject(new RpcFailure(frame.error))
      else call?.resolve(frame.result)
    }
    const ready = this.waiters.filter((w) => w.match(frame))
    this.waiters = this.waiters.filter((w) => !ready.includes(w))
    for (const w of ready) w.resolve(frame)
  }

  request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  sendRaw(data: string): void {
    this.ws.send(data)
  }

  notify(method: string, params: unknown = {}): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  hello(adapter = '0.3.0', protocol: readonly string[] = [PROTOCOL_VERSION]) {
    return this.request('hello', {
      protocol,
      bridge: { agent_kind: 'claude-code', agent_version: '2.1.0', adapter, host: 'laptop' },
    })
  }

  open(localKey: string, extra: Record<string, unknown> = {}) {
    return this.request<{ session_id: string; rooms: { room_id: string; handle: string; status: string }[] }>(
      'session.open',
      {
        local_key: localKey,
        card: { agent: { kind: 'claude-code', adapter: '0.3.0' }, host: 'laptop' },
        ...extra,
      },
    )
  }

  /** Resolves with the first already-received or future notification matching `name` and `match`. */
  waitFor(
    name: string,
    match: (params: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const test = (f: Frame) => f.method === name && match(f.params ?? {})
    const seen = this.frames.find(test)
    if (seen) return Promise.resolve(seen.params ?? {})
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeoutMs)
      this.waiters.push({
        match: test,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f.params ?? {})
        },
      })
    })
  }

  notifications(name: string): Record<string, unknown>[] {
    return this.frames.filter((f) => f.method === name).map((f) => f.params ?? {})
  }

  close(): void {
    this.ws.close()
  }
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
