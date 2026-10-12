/**
 * `session_rooms`: the rooms a session means to be in, with the handle it last held there. Kept across
 * close/offline so revive and reattach can re-claim (§4); removed by leave, remove, exit, kick, dissolve.
 */
import type { Database } from 'bun:sqlite'

export interface SessionRoomRow {
  readonly session_id: string
  readonly room_id: string
  readonly handle: string
}

export function createSessionRoomsRepo(db: Database) {
  return {
    upsert(sessionId: string, roomId: string, handle: string): void {
      db.query(
        'INSERT INTO session_rooms (session_id, room_id, handle) VALUES (?, ?, ?) ON CONFLICT(session_id, room_id) DO UPDATE SET handle = excluded.handle',
      ).run(sessionId, roomId, handle)
    },
    forSession(sessionId: string): readonly SessionRoomRow[] {
      return db
        .query<SessionRoomRow, [string]>('SELECT * FROM session_rooms WHERE session_id = ? ORDER BY rowid')
        .all(sessionId)
    },
    delete(sessionId: string, roomId: string): void {
      db.query('DELETE FROM session_rooms WHERE session_id = ? AND room_id = ?').run(sessionId, roomId)
    },
    deleteRoom(roomId: string): void {
      db.query('DELETE FROM session_rooms WHERE room_id = ?').run(roomId)
    },
    deleteHandle(roomId: string, handle: string): void {
      db.query('DELETE FROM session_rooms WHERE room_id = ? AND handle = ?').run(roomId, handle)
    },
    renameHandle(roomId: string, from: string, to: string): void {
      db.query('UPDATE session_rooms SET handle = ? WHERE room_id = ? AND handle = ?').run(to, roomId, from)
    },
  }
}
export type SessionRoomsRepo = ReturnType<typeof createSessionRoomsRepo>
