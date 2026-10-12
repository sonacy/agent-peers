/**
 * Per-connection JSON-RPC dispatch (§1, §4, §6.4): hello/welcome with `min_adapter`, zod validation
 * at the boundary, session ownership checks, ordered processing, `bye`, and protocol error mapping.
 */
import {
  decodeFrame,
  encodeError,
  encodeResult,
  isAdapterOutdated,
  isPeersError,
  type MethodName,
  negotiateProtocol,
  PeersError,
  parseParams,
  parseRequest,
  type RpcId,
  SUPPORTED_PROTOCOLS,
} from '@agent-peers/protocol'
import type { HubConfig } from '../config'
import type { Services } from '../services/index'
import type { Connection } from './connection'
import { HANDLERS, type HandlerContext, type Reply } from './handlers/index'
import type { Registry } from './registry'

export const VERSION_CLOSE_CODE = 4002

type AnyHandler = (ctx: HandlerContext, params: unknown) => Reply

export interface DispatcherDeps {
  readonly services: Services
  readonly registry: Registry
  readonly config: HubConfig
}

export function createDispatcher(deps: DispatcherDeps) {
  const { services, registry, config } = deps
  const logger = config.logger

  const sendError = (conn: Connection, id: RpcId | null, error: unknown) => {
    if (!isPeersError(error)) logger.error('request failed', error)
    conn.send(encodeError(id, error))
  }

  const hello = (conn: Connection, params: unknown): Reply => {
    const parsed = parseParams('hello', params)
    const protocol = negotiateProtocol(parsed.protocol)
    if (protocol === undefined) {
      throw new PeersError('version_unsupported', 'no common protocol version', {
        supported: [...SUPPORTED_PROTOCOLS],
      })
    }
    conn.hello = {
      agentKind: parsed.bridge.agent_kind,
      adapter: parsed.bridge.adapter,
      host: parsed.bridge.host,
      protocol,
    }
    conn.outdated = isAdapterOutdated(parsed.bridge.adapter, config.minAdapter)
    return {
      result: {
        protocol,
        heartbeat_ms: config.heartbeatMs,
        grace_ms: config.graceMs,
        server_time: services.deps.now(),
        ...(config.minAdapter !== undefined ? { min_adapter: config.minAdapter } : {}),
      },
    }
  }

  /** Session-scoped requests must name a session on this connection (§6.4). */
  const checkSession = (conn: Connection, method: MethodName, params: unknown) => {
    if (method === 'session.open' || typeof params !== 'object' || params === null) return
    const sessionId = (params as { session_id?: unknown }).session_id
    if (typeof sessionId === 'string' && !conn.sessions.has(sessionId)) {
      throw new PeersError('unknown_session', 'that session is not open on this connection')
    }
  }

  const route = (conn: Connection, method: string, params: unknown): Reply => {
    if (method === 'hello') return hello(conn, params)
    if (!conn.hello) throw new PeersError('invalid_request', 'send hello first')
    const parsed = parseRequest(method, params)
    const name = method as MethodName
    checkSession(conn, name, parsed)
    const handler = HANDLERS[name] as AnyHandler | undefined
    if (!handler) throw new PeersError('method_not_found', `method not found: ${method}`)
    return handler({ conn, services, registry, config }, parsed)
  }

  const respond = (conn: Connection, id: RpcId, reply: Reply) => {
    try {
      conn.send(encodeResult(id, reply.result))
    } catch (error) {
      sendError(conn, id, error)
      return
    }
    try {
      reply.after?.()
    } catch (error) {
      logger.error('post-response delivery failed', error)
    }
  }

  const request = (conn: Connection, id: RpcId, method: string, params: unknown) => {
    try {
      respond(conn, id, route(conn, method, params))
    } catch (error) {
      sendError(conn, id, error)
      if (isPeersError(error, 'version_unsupported')) conn.close(VERSION_CLOSE_CODE, 'version unsupported')
    }
  }

  /** `bye`: the sessions go offline at once and the hub closes the socket (§4, §5.1). */
  const bye = (conn: Connection) => {
    conn.closing = true
    for (const id of registry.remove(conn)) services.presence.offline(id)
    conn.close(1000, 'bye')
  }

  /** Handles one text frame; requests run in arrival order on the connection's queue. */
  const handle = (conn: Connection, raw: unknown): Promise<void> =>
    conn.enqueue(() => {
      const frame = decodeFrame(raw)
      switch (frame.type) {
        case 'invalid':
          sendError(conn, frame.id, frame.error)
          return
        case 'notification':
          if (frame.method === 'bye') bye(conn)
          return
        case 'request':
          if (frame.method === 'bye') bye(conn)
          else request(conn, frame.id, frame.method, frame.params)
          return
        default:
          return
      }
    })

  return { handle, bye }
}
export type Dispatcher = ReturnType<typeof createDispatcher>
