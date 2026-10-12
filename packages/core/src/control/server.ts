/**
 * The bridge's control-socket server (ARCHITECTURE §5): binds `run/<pid>.sock` (0600), writes
 * `run/<pid>.json`, serves JSON-lines RPC to hook processes, and removes both files on close.
 */
import { chmod, rm } from 'node:fs/promises'
import { type AgentKind, encodeError, PeersError } from '@agent-peers/protocol'
import type { Socket, UnixSocketListener } from 'bun'
import { ensurePrivateDir } from '../config/fs'
import { FILE_MODE, infoPathFor, socketPathFor } from '../config/paths'
import type { Clock } from '../util/clock'
import { Dispatcher } from './dispatch'
import { LineReader, LineWriter } from './lines'
import { type ControlHandler, MAX_CONTROL_LINE_BYTES } from './ops'
import type { ProcessTree } from './process-tree'
import { bridgeAgent, bridgeAncestors, writeBridgeInfo } from './registry'

/** sun_path is 104 bytes on macOS (108 on Linux), including the NUL. */
export const MAX_SOCKET_PATH_BYTES = 103

export interface ControlServerOptions {
  readonly runDir: string
  readonly handler: ControlHandler
  readonly agentKind: AgentKind
  /** Default `process.pid`. */
  readonly pid?: number
  /** Default: computed from the process tree. */
  readonly ancestorPids?: readonly number[]
  /**
   * The agent process this bridge serves. Default: the parent named in `ancestorPids` when those are
   * given, otherwise the nearest non-launcher ancestor from the process tree.
   */
  readonly agentPid?: number
  readonly tree?: ProcessTree
  readonly localKeys?: readonly string[]
  readonly requestTimeoutMs?: number
  readonly clock?: Clock
  readonly now?: () => number
}

interface Connection {
  readonly reader: LineReader
  readonly writer: LineWriter
  readonly closed: AbortController
}

export class ControlServer {
  private localKeys: readonly string[]
  private listener: UnixSocketListener<Connection> | undefined
  private infoWrite: Promise<void> = Promise.resolve()
  private readonly connections = new Set<Connection>()

  private constructor(
    private readonly options: ControlServerOptions,
    private readonly dispatcher: Dispatcher,
    private readonly ancestors: readonly number[],
    private readonly agentPid: number | undefined,
    readonly pid: number,
    private readonly startedAt: number,
  ) {
    this.localKeys = [...(options.localKeys ?? [])]
  }

  get socketPath(): string {
    return socketPathFor(this.options.runDir, this.pid)
  }

  get infoPath(): string {
    return infoPathFor(this.options.runDir, this.pid)
  }

  static async start(options: ControlServerOptions): Promise<ControlServer> {
    const pid = options.pid ?? process.pid
    const ancestors = options.ancestorPids ?? (await bridgeAncestors(options.tree, pid))
    const agentPid = await ControlServer.agentOf(options, pid)
    const dispatcher = new Dispatcher({
      handler: options.handler,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    })
    const server = new ControlServer(
      options,
      dispatcher,
      ancestors,
      agentPid,
      pid,
      (options.now ?? Date.now)(),
    )
    await server.bind()
    return server
  }

  private static async agentOf(options: ControlServerOptions, pid: number): Promise<number | undefined> {
    if (options.agentPid !== undefined) return options.agentPid
    if (options.ancestorPids !== undefined) {
      const parent = options.ancestorPids[1]
      return parent !== undefined && parent > 1 ? parent : undefined
    }
    return bridgeAgent(options.tree, pid)
  }

  private async bind(): Promise<void> {
    const path = this.socketPath
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
      throw new PeersError(
        'internal',
        `control socket path is too long (${Buffer.byteLength(path)} bytes): ${path}`,
      )
    await ensurePrivateDir(this.options.runDir)
    await rm(path, { force: true })
    try {
      this.listener = Bun.listen<Connection>({ unix: path, socket: this.socketHandlers() })
    } catch (error) {
      throw new PeersError('internal', `cannot bind control socket: ${String(error)}`, undefined, {
        cause: error,
      })
    }
    try {
      await chmod(path, FILE_MODE)
      await this.writeInfo()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private socketHandlers() {
    return {
      open: (socket: Socket<Connection>) => {
        const connection: Connection = {
          reader: new LineReader(MAX_CONTROL_LINE_BYTES),
          writer: new LineWriter(socket),
          closed: new AbortController(),
        }
        socket.data = connection
        this.connections.add(connection)
      },
      data: (socket: Socket<Connection>, chunk: Uint8Array) => this.onData(socket.data, chunk),
      drain: (socket: Socket<Connection>) => socket.data?.writer.drain(),
      close: (socket: Socket<Connection>) => this.onClose(socket.data),
      error: (socket: Socket<Connection>) => this.onClose(socket.data),
    }
  }

  private onData(connection: Connection | undefined, chunk: Uint8Array): void {
    if (!connection || connection.closed.signal.aborted) return
    for (const event of connection.reader.push(chunk)) {
      if ('overflow' in event) {
        connection.writer.writeLine(
          encodeError(null, new PeersError('payload_too_large', 'request line too long')),
        )
        connection.writer.end()
        return
      }
      const deliver = (text: string): boolean => {
        if (connection.closed.signal.aborted) return false
        connection.writer.writeLine(text)
        return true
      }
      void this.dispatcher.handleLine(event.line, connection.closed.signal, deliver)
    }
  }

  private onClose(connection: Connection | undefined): void {
    if (!connection) return
    connection.closed.abort()
    this.connections.delete(connection)
  }

  /** Replaces the advertised local keys and rewrites the info file. */
  setLocalKeys(keys: readonly string[]): Promise<void> {
    this.localKeys = [...new Set(keys)]
    return this.writeInfo()
  }

  get advertisedKeys(): readonly string[] {
    return this.localKeys
  }

  private writeInfo(): Promise<void> {
    const write = () =>
      writeBridgeInfo(this.options.runDir, {
        pid: this.pid,
        ancestor_pids: [...this.ancestors],
        ...(this.agentPid === undefined ? {} : { agent_pid: this.agentPid }),
        agent_kind: this.options.agentKind,
        local_keys: [...this.localKeys],
        started_at: this.startedAt,
      })
    this.infoWrite = this.infoWrite.then(write, write)
    return this.infoWrite
  }

  /** Stops listening, aborts in-flight requests and unlinks the socket and info file. */
  async close(): Promise<void> {
    const listener = this.listener
    this.listener = undefined
    if (!listener) return
    this.dispatcher.abortAll()
    for (const connection of this.connections) connection.closed.abort()
    this.connections.clear()
    listener.stop(true)
    await this.infoWrite.catch(() => undefined)
    await rm(this.socketPath, { force: true })
    await rm(this.infoPath, { force: true })
  }
}
