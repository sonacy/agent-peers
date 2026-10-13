/**
 * A minimal JSON-RPC client for `codex app-server` (stdio, newline-delimited JSON). It spawns either
 * an embedded app-server (`codex app-server`) or a stdio proxy to the shared daemon
 * (`codex app-server proxy`), records every notification, and answers server→client requests with a
 * caller-supplied policy (the "user" of these live tests).
 */

export interface RpcMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export interface Notification {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly at: number
}

/** Answers a server request (approvals, elicitations). Return undefined to answer with an error. */
export type ServerRequestPolicy = (method: string, params: Record<string, unknown>) => unknown

export interface RpcSpawnOptions {
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly cwd: string
  readonly policy: ServerRequestPolicy
  /** `lines`: newline-delimited JSON (embedded app-server); `websocket`: through `app-server proxy`. */
  readonly framing?: 'lines' | 'websocket'
  readonly log?: (line: string) => void
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly method: string
}

import { encodeFrame, encodeText, upgradeRequest, WsDecoder } from './codex-ws'

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

export class CodexRpc {
  private nextId = 1
  private pending: ReadonlyMap<number, Pending> = new Map()
  private notes: readonly Notification[] = []
  private stderrText = ''
  private closed = false
  private readonly proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  private readonly log: (line: string) => void
  private readonly websocket: boolean
  private upgraded = false
  private backlog: readonly string[] = []

  private constructor(private readonly options: RpcSpawnOptions) {
    this.log = options.log ?? (() => undefined)
    this.websocket = options.framing === 'websocket'
    this.proc = Bun.spawn([...options.argv], {
      env: options.env,
      cwd: options.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (this.websocket) {
      this.proc.stdin.write(upgradeRequest())
      this.proc.stdin.flush()
      void this.readFrames(this.proc.stdout)
    } else void this.readLines(this.proc.stdout, (line) => this.onLine(line))
    void this.readLines(this.proc.stderr, (line) => {
      if (this.stderrText.length < 64_000) this.stderrText += `${line}\n`
    })
    void this.proc.exited.then((code) => {
      this.closed = true
      for (const [, waiter] of this.pending)
        waiter.reject(new Error(`app-server exited (${code}) during ${waiter.method}`))
      this.pending = new Map()
    })
  }

  static async start(options: RpcSpawnOptions, timeoutMs = 30_000): Promise<CodexRpc> {
    const rpc = new CodexRpc(options)
    await rpc.request(
      'initialize',
      { clientInfo: { name: 'agent-peers-live', version: '0.0.0' }, capabilities: { experimentalApi: true } },
      timeoutMs,
    )
    rpc.notify('initialized', {})
    return rpc
  }

  get pid(): number {
    return this.proc.pid
  }

  get notifications(): readonly Notification[] {
    return this.notes
  }

  get stderr(): string {
    return this.stderrText
  }

  /** A position in the notification log, to look only at later notifications. */
  mark(): number {
    return this.notes.length
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`app-server is closed (${method})`))
    const id = this.nextId++
    const reply = new Promise<T>((resolve, reject) => {
      this.pending = new Map(this.pending).set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        method,
      })
    })
    this.write({ id, method, params })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs)
    })
    return Promise.race([reply, timeout]).finally(() => clearTimeout(timer))
  }

  /** Waits for a notification matching `match` at or after `after`. */
  async waitFor(
    what: string,
    match: (note: Notification) => boolean,
    timeoutMs: number,
    after = 0,
  ): Promise<Notification> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.notes.slice(after).find(match)
      if (found) return found
      if (this.closed) throw new Error(`app-server closed while waiting for ${what}\n${this.stderrText}`)
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
      await Bun.sleep(100)
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try {
        this.proc.stdin.end()
      } catch {
        // already closed
      }
      this.proc.kill('SIGTERM')
      const exited = await Promise.race([
        this.proc.exited.then(() => true),
        Bun.sleep(3000).then(() => false),
      ])
      if (!exited) this.proc.kill('SIGKILL')
    }
    this.closed = true
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return
    const text = JSON.stringify(message)
    if (this.websocket && !this.upgraded) {
      this.backlog = [...this.backlog, text]
      return
    }
    this.proc.stdin.write(this.websocket ? encodeText(text) : `${text}\n`)
    this.proc.stdin.flush()
  }

  private flushBacklog(): void {
    this.upgraded = true
    for (const text of this.backlog) this.proc.stdin.write(encodeText(text))
    this.backlog = []
    this.proc.stdin.flush()
  }

  private async readFrames(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new WsDecoder()
    const reader = stream.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const out = decoder.push(chunk.value)
        if (decoder.isUpgraded && !this.upgraded) this.flushBacklog()
        for (const ping of out.pings) this.proc.stdin.write(encodeFrame(0xa, ping))
        if (out.pings.length > 0) this.proc.stdin.flush()
        for (const message of out.messages) this.onLine(message)
        if (out.closed) break
      }
    } catch (error) {
      this.log(`app-server websocket: ${String(error)}`)
    }
  }

  private onLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.log(`app-server: non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    if (message.method !== undefined && message.id !== undefined) {
      this.answer(message)
      return
    }
    if (message.method !== undefined) {
      this.notes = [
        ...this.notes,
        { method: message.method, params: asRecord(message.params), at: Date.now() },
      ]
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    const rest = new Map(this.pending)
    rest.delete(message.id)
    this.pending = rest
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`))
    else waiter.resolve(message.result)
  }

  private answer(message: RpcMessage): void {
    const method = message.method ?? ''
    const params = asRecord(message.params)
    this.notes = [...this.notes, { method: `request:${method}`, params, at: Date.now() }]
    const result = this.options.policy(method, params)
    this.log(`server request ${method} → ${JSON.stringify(result)}`)
    if (result === undefined)
      this.write({ id: message.id, error: { code: -32601, message: `live test client refuses ${method}` } })
    else this.write({ id: message.id, result })
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      const reader = stream.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) onLine(line)
          index = buffer.indexOf('\n')
        }
      }
    } catch {
      // the process went away
    }
  }
}
