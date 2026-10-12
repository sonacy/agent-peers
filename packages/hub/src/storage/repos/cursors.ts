/** `cursors`: the highest acked `seq` per (room, handle) (§6.3). */
import type { Database } from 'bun:sqlite'

export function createCursorsRepo(db: Database) {
  return {
    get(roomId: string, handle: string): number | undefined {
      const row = db
        .query<{ seq: number }, [string, string]>('SELECT seq FROM cursors WHERE room_id = ? AND handle = ?')
        .get(roomId, handle)
      return row?.seq
    },
    set(roomId: string, handle: string, seq: number): void {
      db.query(
        'INSERT INTO cursors (room_id, handle, seq) VALUES (?, ?, ?) ON CONFLICT(room_id, handle) DO UPDATE SET seq = excluded.seq',
      ).run(roomId, handle, seq)
    },
    delete(roomId: string, handle: string): void {
      db.query('DELETE FROM cursors WHERE room_id = ? AND handle = ?').run(roomId, handle)
    },
    rename(roomId: string, from: string, to: string): void {
      db.query('DELETE FROM cursors WHERE room_id = ? AND handle = ?').run(roomId, to)
      db.query('UPDATE cursors SET handle = ? WHERE room_id = ? AND handle = ?').run(to, roomId, from)
    },
  }
}
export type CursorsRepo = ReturnType<typeof createCursorsRepo>
