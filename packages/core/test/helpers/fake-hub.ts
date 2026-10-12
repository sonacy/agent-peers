/** In-test hub: Bun.serve on port 0 speaking just enough JSON-RPC for the client tests. */
import type { Server, ServerWebSocket } from 'bun'

export interface Call {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly id: number | string | undefined
  readonly conn: number
}

export type Reply =
  | { readonly result: unknown }
  | { readonly error: { code: number; message: string; data?: unknown } }
  | { readonly noreply: true }
  | { readonly drop: true }

export type Handler = (params: Record<string, unknown>, call: Call) => Reply | Promise<Reply>

interface ConnData {
  readonly index: number
  readonly auth: string | null
}

export const ok = (result: unknown): Reply => ({ result })
export const fail = (code: string, message = code, extra: Record<string, unknown> = {}): Reply => ({
  error: { code: -32000, message, data: { code, ...extra } },
})

export class FakeHub {
  readonly calls: Call[] = []
  readonly responses: unknown[] = []
  readonly auths: (string | null)[] = []
  readonly handlers = new Map<string, Handler>()
  heartbeatMs = 10_000
  minAdapter: string | undefined = '0.1.0'
  /** When true the hub goes silent: no responses, no pongs (a dead link). */
  mute = false
  rejectUpgrade = false
  /** Like the real hub with a bad or revoked token: `hello` gets `unauthorized`, then a 4401 close. */
  refuseToken = false
  private readonly sockets = new Map<number, ServerWebSocket<ConnData>>()
  private connCount = 0
  private readonly server: Server<ConnData>

  constructor() {
    this.server = Bun.serve<ConnData>({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, server) => {
        if (this.rejectUpgrade) return new Response('unauthorized', { status: 401 })
        this.connCount += 1
        const data = { index: this.connCount, auth: req.headers.get('authorization') }
        if (server.upgrade(req, { data })) return undefined
        return new Response('expected websocket', { status: 400 })
      },
      websocket: {
        open: (ws) => {
          this.auths.push(ws.data.auth)
          this.sockets.set(ws.data.index, ws)
        },
        message: (ws, raw) => {
          void this.onMessage(ws, String(raw))
        },
        close: (ws) => {
          this.sockets.delete(ws.data.index)
        },
      },
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  get connections(): number {
    return this.connCount
  }

  get openSockets(): number {
    return this.sockets.size
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler)
    return this
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method)
  }

  /** Sends a notification on the newest open connection. */
  notify(method: string, params: unknown): void {
    this.latest()?.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  sendRaw(text: string): void {
    this.latest()?.send(text)
  }

  dropAll(code = 1011): void {
    for (const ws of this.sockets.values()) ws.close(code, 'dropped by test')
  }

  async waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await Bun.sleep(5)
    }
  }

  stop(): void {
    this.server.stop(true)
  }

  private latest(): ServerWebSocket<ConnData> | undefined {
    return [...this.sockets.values()].at(-1)
  }

  private async onMessage(ws: ServerWebSocket<ConnData>, raw: string): Promise<void> {
    const frame = JSON.parse(raw) as { id?: number; method?: string; params?: Record<string, unknown> }
    if (frame.method === undefined) {
      this.responses.push(frame)
      return
    }
    const call: Call = { method: frame.method, params: frame.params ?? {}, id: frame.id, conn: ws.data.index }
    this.calls.push(call)
    if (this.mute || frame.id === undefined) return
    if (this.refuseToken) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...fail('unauthorized') }))
      ws.close(4401, 'unauthorized')
      return
    }
    const reply = await this.reply(call)
    if ('noreply' in reply) return
    if ('drop' in reply) {
      ws.close(1011, 'drop')
      return
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...reply }))
  }

  private reply(call: Call): Reply | Promise<Reply> {
    const handler = this.handlers.get(call.method)
    if (handler) return handler(call.params, call)
    if (call.method === 'hello') {
      return ok({
        protocol: 'agent-peers/0.3',
        heartbeat_ms: this.heartbeatMs,
        grace_ms: 90_000,
        server_time: Date.now(),
        ...(this.minAdapter ? { min_adapter: this.minAdapter } : {}),
      })
    }
    if (call.method === 'ping') return ok({ server_time: Date.now() })
    return { error: { code: -32601, message: `method not found: ${call.method}` } }
  }
}

export const bridge = {
  agent_kind: 'claude-code',
  agent_version: '2.1.0',
  adapter: '0.2.0',
  host: 'test-host',
}

/** A complete §3 session card for fixtures. */
export const fullCard = (session_id: string, extra: Record<string, unknown> = {}) => ({
  session_id,
  member: 'gulei',
  agent: { kind: 'claude-code' },
  host: 'test-host',
  inject: 'push',
  connection: 'online',
  activity: 'idle',
  accepting: true,
  rooms: [],
  last_seen_at: 1,
  last_activity_at: 1,
  ...extra,
})
