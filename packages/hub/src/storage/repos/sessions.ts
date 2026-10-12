/** `sessions`: one agent conversation, keyed by (member, host, agent_kind, local_key) (§2, §4). */
import type { Database } from 'bun:sqlite'
import type { ConnectionState } from '@agent-peers/protocol'

export interface SessionRow {
  readonly id: string
  readonly member_id: string
  readonly host: string
  readonly agent_kind: string
  readonly local_key: string
  readonly card_json: string
  readonly connection: ConnectionState
  readonly outdated: number
  readonly created_at: number
  readonly last_seen_at: number
  readonly last_activity_at: number
  readonly closed_at: number | null
}

export interface SessionIdentity {
  readonly member_id: string
  readonly host: string
  readonly agent_kind: string
  readonly local_key: string
}

export type SessionInsert = Omit<SessionRow, 'closed_at'>

export function createSessionsRepo(db: Database) {
  return {
    insert(row: SessionInsert): void {
      db.query(
        `INSERT INTO sessions (id, member_id, host, agent_kind, local_key, card_json, connection, outdated, created_at, last_seen_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.member_id,
        row.host,
        row.agent_kind,
        row.local_key,
        row.card_json,
        row.connection,
        row.outdated,
        row.created_at,
        row.last_seen_at,
        row.last_activity_at,
      )
    },
    byId(id: string): SessionRow | undefined {
      return db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(id) ?? undefined
    },
    byIdentity(identity: SessionIdentity): SessionRow | undefined {
      return (
        db
          .query<SessionRow, [string, string, string, string]>(
            'SELECT * FROM sessions WHERE member_id = ? AND host = ? AND agent_kind = ? AND local_key = ?',
          )
          .get(identity.member_id, identity.host, identity.agent_kind, identity.local_key) ?? undefined
      )
    },
    forMember(memberId: string): readonly SessionRow[] {
      return db
        .query<SessionRow, [string]>('SELECT * FROM sessions WHERE member_id = ? ORDER BY created_at, id')
        .all(memberId)
    },
    list(): readonly SessionRow[] {
      return db.query<SessionRow, []>('SELECT * FROM sessions ORDER BY created_at, id').all()
    },
    notOffline(): readonly SessionRow[] {
      return db.query<SessionRow, []>("SELECT * FROM sessions WHERE connection <> 'offline'").all()
    },
    /** Open sessions with no activity since `cutoff` (the hub-side idle-close backstop). */
    idleOpen(cutoff: number): readonly SessionRow[] {
      return db
        .query<SessionRow, [number]>(
          'SELECT * FROM sessions WHERE closed_at IS NULL AND last_activity_at <= ?',
        )
        .all(cutoff)
    },
    reopen(id: string, cardJson: string, outdated: boolean, now: number): void {
      db.query(
        'UPDATE sessions SET card_json = ?, outdated = ?, closed_at = NULL, last_seen_at = ?, last_activity_at = ? WHERE id = ?',
      ).run(cardJson, outdated ? 1 : 0, now, now, id)
    },
    updateCard(id: string, cardJson: string, lastActivityAt: number): void {
      db.query('UPDATE sessions SET card_json = ?, last_activity_at = ? WHERE id = ?').run(
        cardJson,
        lastActivityAt,
        id,
      )
    },
    setConnection(id: string, connection: ConnectionState, lastSeenAt: number): void {
      db.query('UPDATE sessions SET connection = ?, last_seen_at = ? WHERE id = ?').run(
        connection,
        lastSeenAt,
        id,
      )
    },
    close(id: string, now: number): void {
      db.query(
        "UPDATE sessions SET closed_at = ?, connection = 'offline', last_seen_at = ? WHERE id = ?",
      ).run(now, now, id)
    },
  }
}
export type SessionsRepo = ReturnType<typeof createSessionsRepo>
