/** `asks`: the §6.2 record (state, assignee, failure reason, expiry). */
import type { Database } from 'bun:sqlite'
import type { AskFailReason, AskState } from '@agent-peers/protocol'

export interface AskRow {
  readonly id: string
  readonly room_id: string
  readonly from_handle: string
  readonly from_member_id: string
  readonly from_member: string
  readonly to_handle: string
  readonly state: AskState
  readonly assignee_session: string | null
  readonly reason: AskFailReason | null
  readonly expires_at: number
  readonly created_at: number
  readonly updated_at: number
}

export type AskInsert = Omit<AskRow, 'assignee_session' | 'reason' | 'updated_at'>

const OPEN = "state IN ('queued', 'delivered', 'working')"

export interface AskTransition {
  readonly state: AskState
  /** Omitted: keep the current assignee. */
  readonly assignee_session?: string | null
  readonly reason?: AskFailReason | null
}

export function createAsksRepo(db: Database) {
  const all = (sql: string, ...params: (string | number)[]) =>
    db.query<AskRow, (string | number)[]>(sql).all(...params)
  return {
    insert(row: AskInsert): void {
      db.query(
        `INSERT INTO asks (id, room_id, from_handle, from_member_id, from_member, to_handle, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.room_id,
        row.from_handle,
        row.from_member_id,
        row.from_member,
        row.to_handle,
        row.state,
        row.expires_at,
        row.created_at,
        row.created_at,
      )
    },
    byId(id: string): AskRow | undefined {
      return db.query<AskRow, [string]>('SELECT * FROM asks WHERE id = ?').get(id) ?? undefined
    },
    /**
     * Compare-and-set: applies `next` only while the ask is still in `expected`. Returns the updated
     * row, or undefined when another writer got there first.
     */
    transition(
      id: string,
      expected: readonly AskState[],
      next: AskTransition,
      now: number,
    ): AskRow | undefined {
      const placeholders = expected.map(() => '?').join(', ')
      return (
        db
          .query<AskRow, (string | number | null)[]>(
            `UPDATE asks SET state = ?, assignee_session = CASE WHEN ? THEN ? ELSE assignee_session END,
               reason = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders}) RETURNING *`,
          )
          .get(
            next.state,
            next.assignee_session === undefined ? 0 : 1,
            next.assignee_session ?? null,
            next.reason ?? null,
            now,
            id,
            ...expected,
          ) ?? undefined
      )
    },
    openTo(roomId: string, handle: string): readonly AskRow[] {
      return all(
        `SELECT * FROM asks WHERE room_id = ? AND to_handle = ? AND ${OPEN} ORDER BY created_at, id`,
        roomId,
        handle,
      )
    },
    /** Open asks to or from a handle (§6.2 `not_in_room`). */
    openInvolving(roomId: string, handle: string): readonly AskRow[] {
      return all(
        `SELECT * FROM asks WHERE room_id = ? AND (to_handle = ? OR from_handle = ?) AND ${OPEN} ORDER BY created_at, id`,
        roomId,
        handle,
        handle,
      )
    },
    openInRoom(roomId: string): readonly AskRow[] {
      return all(`SELECT * FROM asks WHERE room_id = ? AND ${OPEN} ORDER BY created_at, id`, roomId)
    },
    workingFor(sessionId: string): readonly AskRow[] {
      return all(
        "SELECT * FROM asks WHERE assignee_session = ? AND state = 'working' ORDER BY created_at",
        sessionId,
      )
    },
    countOpenTo(roomId: string, handle: string): number {
      const row = db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM asks WHERE room_id = ? AND to_handle = ? AND ${OPEN}`,
        )
        .get(roomId, handle)
      return row?.n ?? 0
    },
    countOpenFromMemberTo(roomId: string, memberId: string, handle: string): number {
      const row = db
        .query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM asks WHERE room_id = ? AND from_member_id = ? AND to_handle = ? AND ${OPEN}`,
        )
        .get(roomId, memberId, handle)
      return row?.n ?? 0
    },
    due(now: number): readonly AskRow[] {
      return all(`SELECT * FROM asks WHERE ${OPEN} AND expires_at <= ? ORDER BY expires_at`, now)
    },
    /** §2.2: open asks addressed to or sent by the old handle move to the new one. */
    renameHandle(roomId: string, from: string, to: string): void {
      db.query(`UPDATE asks SET to_handle = ? WHERE room_id = ? AND to_handle = ? AND ${OPEN}`).run(
        to,
        roomId,
        from,
      )
      db.query(`UPDATE asks SET from_handle = ? WHERE room_id = ? AND from_handle = ? AND ${OPEN}`).run(
        to,
        roomId,
        from,
      )
    },
    /** Asks in the given rooms, newest first, for the dashboard feed. */
    listForRooms(roomIds: readonly string[], beforeId: string | undefined, limit: number): readonly AskRow[] {
      if (roomIds.length === 0) return []
      const placeholders = roomIds.map(() => '?').join(', ')
      return all(
        `SELECT * FROM asks WHERE room_id IN (${placeholders}) AND id < ? ORDER BY id DESC LIMIT ?`,
        ...roomIds,
        beforeId ?? '~',
        limit,
      )
    },
  }
}
export type AsksRepo = ReturnType<typeof createAsksRepo>
