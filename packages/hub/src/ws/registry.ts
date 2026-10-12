/**
 * Live connections and the session → connection map. Implements the services' SessionLink:
 * every session has its own pub/sub topic, so room fan-out publishes one frame per holder (each
 * frame carries that holder's `session_id`) and fencing is an unsubscribe (§1, §4).
 */
import { encodeNotification, type NotificationName, UNAUTHORIZED_CLOSE_CODE } from '@agent-peers/protocol'
import type { Server } from 'bun'
import type { Logger } from '../config'
import type { NotifyParams, SessionLink } from '../services/context'
import { type Connection, type SocketData, sessionTopic } from './connection'

export const FENCED_CLOSE_CODE = 4001

export class Registry implements SessionLink {
  private readonly connections = new Map<string, Connection>()
  private readonly bySession = new Map<string, Connection>()
  private server: Server<SocketData> | undefined

  constructor(private readonly logger: Logger) {}

  bindServer(server: Server<SocketData> | undefined): void {
    this.server = server
  }

  add(conn: Connection): void {
    this.connections.set(conn.id, conn)
  }

  /** Forgets a closed connection; returns the sessions that were still attached to it. */
  remove(conn: Connection): readonly string[] {
    this.connections.delete(conn.id)
    const orphaned = [...conn.sessions].filter((id) => this.bySession.get(id) === conn)
    for (const id of orphaned) this.bySession.delete(id)
    conn.sessions.clear()
    return orphaned
  }

  /** Attaches a session to `conn`, fencing it off any previous connection (§1 fencing). */
  attach(conn: Connection, sessionId: string): void {
    const previous = this.bySession.get(sessionId)
    if (previous && previous !== conn) this.release(previous, sessionId, true)
    conn.sessions.add(sessionId)
    conn.ws.subscribe(sessionTopic(sessionId))
    this.bySession.set(sessionId, conn)
  }

  detach(sessionId: string): void {
    const conn = this.bySession.get(sessionId)
    if (conn) this.release(conn, sessionId, false)
  }

  private release(conn: Connection, sessionId: string, fenced: boolean): void {
    conn.sessions.delete(sessionId)
    this.bySession.delete(sessionId)
    try {
      conn.ws.unsubscribe(sessionTopic(sessionId))
    } catch {
      // the socket is already closed
    }
    if (fenced && conn.sessions.size === 0) conn.close(FENCED_CLOSE_CODE, 'session reattached elsewhere')
  }

  /**
   * Closes every connection of a member (token revoked) with 4401, so the bridge stops reconnecting.
   * Returns the sessions that were attached; the caller takes them offline.
   */
  disconnectMember(memberId: string, reason = 'token revoked'): readonly string[] {
    return [...this.connections.values()]
      .filter((conn) => conn.memberId === memberId)
      .flatMap((conn) => {
        const orphaned = this.remove(conn)
        conn.close(UNAUTHORIZED_CLOSE_CODE, reason)
        return orphaned
      })
  }

  connectionOf(sessionId: string): Connection | undefined {
    return this.bySession.get(sessionId)
  }

  notify<N extends NotificationName>(sessionId: string, name: N, params: NotifyParams<N>): void {
    if (!this.bySession.has(sessionId) || !this.server) return
    try {
      this.server.publish(
        sessionTopic(sessionId),
        encodeNotification(name, { ...params, session_id: sessionId }),
      )
    } catch (error) {
      this.logger.error(`dropped ${name} for ${sessionId}`, error)
    }
  }

  lastSeen(sessionId: string): number | undefined {
    return this.bySession.get(sessionId)?.lastFrameAt
  }

  get connectionCount(): number {
    return this.connections.size
  }

  get sessionCount(): number {
    return this.bySession.size
  }

  all(): readonly Connection[] {
    return [...this.connections.values()]
  }
}
