/**
 * createHub: the public listener (WebSocket `/v0/ws` + the HTTP mount) and the admin listener
 * (loopback by default) over one SQLite database (§9, ARCHITECTURE §2).
 */
import type { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { WS_PATH } from '@agent-peers/protocol'
import type { Server } from 'bun'
import { bootstrapAdminToken, bootstrapDefaultRoom, ensureDataDir, resolveInviteSecret } from './bootstrap'
import {
  type HubConfig,
  type HubConfigInput,
  isLoopbackBind,
  isMemoryDataDir,
  resolveConfig,
  resolvePublicUrl,
} from './config'
import { MAX_BODY_BYTES } from './http/errors'
import { createHttpMounts } from './http/index'
import type { HttpOptions } from './http/types'
import { createDeps, type Runtime } from './services/context'
import { createEventBus } from './services/events'
import { createServices, type Services } from './services/index'
import { databasePath, openDatabase } from './storage/db'
import { createRepos } from './storage/repos'
import type { SocketData } from './ws/connection'
import { Registry } from './ws/registry'
import { createWebSocketLayer } from './ws/server'

export type PublicServer = Server<SocketData>
export type AdminServer = Server<undefined>
type MaybeResponse = Response | undefined | Promise<Response | undefined>

/** The HTTP layer plugs in here: return undefined to fall through to 404. */
export interface HttpMounts {
  readonly public?: (req: Request, server: PublicServer) => MaybeResponse
  readonly admin?: (req: Request, server: AdminServer) => MaybeResponse
  /** Called on stop, before the listeners close (ends open event streams). */
  readonly close?: () => void
}

export interface HubContext {
  readonly config: HubConfig
  readonly services: Services
  readonly registry: Registry
  readonly runtime: Runtime
}

export interface CreateHubOptions extends HubConfigInput {
  /** Defaults to the built-in HTTP layer (`createHttpMounts`) configured by `http`. */
  readonly mounts?: HttpMounts | ((hub: HubContext) => HttpMounts)
  readonly http?: HttpOptions
}

export interface StartInfo {
  readonly publicPort: number
  readonly adminPort: number
  readonly adminToken: string
  readonly publicUrl?: string
  /** Set on the first start of an invite-only hub: the `default` room's invite (§8). */
  readonly bootstrapInviteUrl?: string
}

export interface Hub extends HubContext {
  readonly db: Database
  start(): Promise<StartInfo>
  stop(): Promise<void>
  setMounts(mounts: HttpMounts): void
}

const DATA_DIR_MODE = 0o700

/** Bun refuses bodies past this before any route runs; routes enforce `MAX_BODY_BYTES` themselves. */
const MAX_REQUEST_BODY_BYTES = MAX_BODY_BYTES + 1024

const notFound = () => new Response('not found', { status: 404 })

/**
 * Stops a listener and closes its sockets. Bun 1.3's `stop(true)` promise never settles once any
 * websocket was closed from the server side (bye, fencing), although the port is released at once,
 * so the wait is bounded.
 */
const STOP_WAIT_MS = 250

async function stopServer(server: { stop(force: boolean): Promise<void> } | undefined): Promise<void> {
  if (!server) return
  await Promise.race([server.stop(true), Bun.sleep(STOP_WAIT_MS)])
}

async function orNotFound(result: MaybeResponse): Promise<Response> {
  return (await result) ?? notFound()
}

export function createHub(options: CreateHubOptions = {}): Hub {
  const config = resolveConfig(options)
  if (!isMemoryDataDir(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true, mode: DATA_DIR_MODE })
    chmodSync(config.dataDir, DATA_DIR_MODE)
  }
  const db = openDatabase(databasePath(config.dataDir))
  const repos = createRepos(db)
  const runtime: Runtime = { publicUrl: undefined, inviteSecret: '' }
  const deps = createDeps({ db, repos, config, events: createEventBus(config.logger), runtime })
  const services = createServices(deps)
  const registry = new Registry(config.logger)
  const context: HubContext = { config, services, registry, runtime }
  let mounts: HttpMounts =
    typeof options.mounts === 'function'
      ? options.mounts(context)
      : (options.mounts ?? createHttpMounts(context, options.http))
  let publicServer: PublicServer | undefined
  let adminServer: AdminServer | undefined

  const servePublic = (): PublicServer => {
    const ws = createWebSocketLayer({ services, registry, config })
    return Bun.serve<SocketData>({
      hostname: config.publicBind,
      port: config.publicPort,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => {
        if (new URL(req.url).pathname === WS_PATH) return ws.upgrade(req, server)
        return orNotFound(mounts.public?.(req, server))
      },
      websocket: ws.websocket,
    })
  }

  const serveAdmin = (): AdminServer => {
    if (!isLoopbackBind(config.adminBind))
      config.logger.warn(`admin listener bound to non-loopback ${config.adminBind}`)
    return Bun.serve({
      hostname: config.adminBind,
      port: config.adminPort,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: (req, server) => orNotFound(mounts.admin?.(req, server)),
    })
  }

  /** Stops whatever listeners are up and unbinds the WS layer (start rollback and stop). */
  const teardown = async (): Promise<void> => {
    services.sweeper.stop()
    services.presence.stop()
    for (const conn of registry.all()) {
      conn.closing = true
      if (conn.staleTimer !== undefined) config.clock.clearTimeout(conn.staleTimer)
      conn.staleTimer = undefined
    }
    const servers = [publicServer, adminServer]
    publicServer = undefined
    adminServer = undefined
    await Promise.all(servers.map(stopServer))
    deps.link.bind(undefined)
    registry.bindServer(undefined)
  }

  const listen = async (): Promise<StartInfo> => {
    await ensureDataDir(config.dataDir)
    runtime.inviteSecret = await resolveInviteSecret(config)
    const firstStart = repos.admin.get() === undefined
    const server = servePublic()
    publicServer = server
    adminServer = serveAdmin()
    registry.bindServer(server)
    deps.link.bind(registry)
    const publicPort = server.port ?? config.publicPort
    runtime.publicUrl = resolvePublicUrl(config, publicPort)
    const adminToken = await bootstrapAdminToken(services, config)
    const bootstrapInviteUrl = bootstrapDefaultRoom(services, config, firstStart)
    services.presence.recover()
    services.sweeper.start()
    return {
      publicPort,
      adminPort: adminServer.port ?? config.adminPort,
      adminToken,
      ...(runtime.publicUrl !== undefined ? { publicUrl: runtime.publicUrl } : {}),
      ...(bootstrapInviteUrl !== undefined ? { bootstrapInviteUrl } : {}),
    }
  }

  let starting = false
  let stopped = false

  /** Starts both listeners; on any failure, whatever was already bound is released again. */
  const start = async (): Promise<StartInfo> => {
    if (stopped) throw new Error('hub was stopped')
    if (publicServer || starting) throw new Error('hub already started')
    starting = true
    try {
      return await listen()
    } catch (error) {
      await teardown()
      throw error
    } finally {
      starting = false
    }
  }

  /**
   * Idempotent. Session connection states are left as they are: the next start gives every session
   * that was attached the grace period, then requeues or fails its asks (§5.1, §6.2).
   */
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    mounts.close?.()
    await teardown()
    db.close()
  }

  return {
    ...context,
    db,
    start,
    stop,
    setMounts(next) {
      mounts = next
    },
  }
}
