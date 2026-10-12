/** `handles`: `@name` per room, owned by a member, held by at most one session (§2, §2.1). */
import type { Database } from 'bun:sqlite'

export interface HandleRow {
  readonly room_id: string
  readonly handle: string
  readonly member_id: string
  readonly session_id: string | null
  readonly created_at: number
}

export function createHandlesRepo(db: Database) {
  return {
    insert(row: HandleRow): void {
      db.query(
        'INSERT INTO handles (room_id, handle, member_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(row.room_id, row.handle, row.member_id, row.session_id, row.created_at)
    },
    get(roomId: string, handle: string): HandleRow | undefined {
      return (
        db
          .query<HandleRow, [string, string]>('SELECT * FROM handles WHERE room_id = ? AND handle = ?')
          .get(roomId, handle) ?? undefined
      )
    },
    bySession(sessionId: string, roomId: string): HandleRow | undefined {
      return (
        db
          .query<HandleRow, [string, string]>('SELECT * FROM handles WHERE session_id = ? AND room_id = ?')
          .get(sessionId, roomId) ?? undefined
      )
    },
    forSession(sessionId: string): readonly HandleRow[] {
      return db
        .query<HandleRow, [string]>(
          `SELECT h.* FROM handles h JOIN rooms r ON r.id = h.room_id
           WHERE h.session_id = ? AND r.dissolved_at IS NULL ORDER BY h.created_at, h.room_id`,
        )
        .all(sessionId)
    },
    forRoom(roomId: string): readonly HandleRow[] {
      return db
        .query<HandleRow, [string]>('SELECT * FROM handles WHERE room_id = ? ORDER BY handle')
        .all(roomId)
    },
    forMemberInRoom(roomId: string, memberId: string): readonly HandleRow[] {
      return db
        .query<HandleRow, [string, string]>(
          'SELECT * FROM handles WHERE room_id = ? AND member_id = ? ORDER BY handle',
        )
        .all(roomId, memberId)
    },
    setHolder(roomId: string, handle: string, sessionId: string | null): void {
      db.query('UPDATE handles SET session_id = ? WHERE room_id = ? AND handle = ?').run(
        sessionId,
        roomId,
        handle,
      )
    },
    rename(roomId: string, from: string, to: string): void {
      db.query('UPDATE handles SET handle = ? WHERE room_id = ? AND handle = ?').run(to, roomId, from)
    },
    delete(roomId: string, handle: string): void {
      db.query('DELETE FROM handles WHERE room_id = ? AND handle = ?').run(roomId, handle)
    },
  }
}
export type HandlesRepo = ReturnType<typeof createHandlesRepo>
