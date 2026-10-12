/**
 * The `/v0/ws` endpoint (§1, §4, §5): Bearer member-token upgrade, Bun websocket handlers,
 * heartbeat-driven staleness and clean/unclean close handling.
 */
import {
  DEAD_AFTER_HEARTBEATS,
  decodeFrame,
  encodeError,
  MAX_FRAME_BYTES,
  PeersError,
  UNAUTHORIZED_CLOSE_CODE,
} from '@agent-peers/protocol'
import type { Server, WebSocketHandler } from 'bun'
import { bearerToken } from '../auth/tokens'
import { guarded, type TimerHandle } from '../clock'
import type { HubConfig } from '../config'
import type { Services } from '../services/index'
import { Connection, type HubSocket, type SocketData } from './connection'
import { createDispatcher } from './dispatch'
import type { Registry } from './registry'

/** Bun closes sockets above this; frames between 256 KiB and here get a `payload_too_large` error. */
export const MAX_PAYLOAD_LENGTH = MAX_FRAME_BYTES * 4

export interface WebSocketLayerDeps {
  readonly services: Services
  readonly registry: Registry
  readonly config: HubConfig
}

export function createWebSocketLayer(deps: WebSocketLayerDeps) {
  const { services, registry, config } = deps
  const { clock } = config
  const dispatcher = createDispatcher(deps)
  const connections = new WeakMap<HubSocket, Connection>()
  const deadAfter = config.heartbeatMs * DEAD_AFTER_HEARTBEATS

  /**
   * Authenticates the upgrade with `Authorization: Bearer <member_token>` (§4). A bad token still
   * gets a socket: a WebSocket client can't read the status of a refused upgrade, and must be able
   * to tell a revoked token from a network failure. That socket serves nothing; see `refuse`.
   */
  const upgrade = (req: Request, server: Server<SocketData>): Response | undefined => {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }
    const token = bearerToken(req.headers.get('authorization'))
    const member = token === undefined ? undefined : services.members.authenticate(token)
    const connId = services.deps.newId()
    const data: SocketData = member
      ? { connId, memberId: member.id }
      : { connId, memberId: '', unauthorized: true }
    return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 })
  }

  const refusals = new WeakMap<HubSocket, TimerHandle>()

  /**
   * Ends a socket whose token was refused: its first request (`hello`) gets an `unauthorized`
   * error, then the socket is closed with 4401. One that sends nothing is closed after 2×heartbeat.
   */
  const refuse = (ws: HubSocket, raw?: string | Buffer): void => {
    const timer = refusals.get(ws)
    if (timer !== undefined) clock.clearTimeout(timer)
    refusals.delete(ws)
    const frame = raw === undefined ? undefined : decodeFrame(raw)
    if (frame?.type === 'request') {
      ws.send(encodeError(frame.id, new PeersError('unauthorized', 'a valid member token is required')))
    }
    ws.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized')
  }

  const armStaleTimer = (conn: Connection) => {
    if (conn.staleTimer !== undefined) clock.clearTimeout(conn.staleTimer)
    conn.staleTimer = clock.setTimeout(
      guarded(config.logger, 'heartbeat stale timer', () => {
        conn.staleTimer = undefined
        conn.stale = true
        services.presence.stale([...conn.sessions])
      }),
      deadAfter,
    )
  }

  /** Any frame: the connection is alive (§5.1). Sessions that had gone offline get a fresh delivery. */
  const noteFrame = (conn: Connection) => {
    conn.lastFrameAt = clock.now()
    armStaleTimer(conn)
    if (!conn.stale) return
    conn.stale = false
    for (const id of services.presence.revive([...conn.sessions])) {
      for (const room of services.cards.byId(id)?.rooms ?? []) {
        services.messages.deliverRoom(id, room.room_id, room.handle)
      }
    }
  }

  const websocket: WebSocketHandler<SocketData> = {
    maxPayloadLength: MAX_PAYLOAD_LENGTH,
    idleTimeout: 0,
    open(ws) {
      if (ws.data.unauthorized) {
        refusals.set(
          ws,
          clock.setTimeout(
            guarded(config.logger, 'refused socket', () => refuse(ws)),
            deadAfter,
          ),
        )
        return
      }
      const conn = new Connection(ws, clock.now())
      connections.set(ws, conn)
      registry.add(conn)
      armStaleTimer(conn)
    },
    message(ws, raw) {
      if (ws.data.unauthorized) {
        refuse(ws, raw)
        return
      }
      const conn = connections.get(ws)
      if (!conn) return
      noteFrame(conn)
      void dispatcher.handle(conn, raw)
    },
    close(ws) {
      const refusal = refusals.get(ws)
      if (refusal !== undefined) clock.clearTimeout(refusal)
      const conn = connections.get(ws)
      if (!conn) return
      connections.delete(ws)
      if (conn.staleTimer !== undefined) clock.clearTimeout(conn.staleTimer)
      const orphaned = registry.remove(conn)
      if (!conn.closing) services.presence.stale(orphaned)
    },
  }

  return { upgrade, websocket, dispatcher }
}
