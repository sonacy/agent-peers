/** `rooms`: unique active slug, display name, description, discoverability, head seq (§2, §10). */
import type { Database } from 'bun:sqlite'

export interface RoomRow {
  readonly id: string
  readonly name: string
  readonly display_name: string | null
  readonly description: string | null
  readonly discoverable: number
  readonly owner_member_id: string | null
  readonly head_seq: number
  readonly created_at: number
  readonly dissolved_at: number | null
}

export interface RoomInsert {
  readonly id: string
  readonly name: string
  readonly display_name?: string | undefined
  readonly description?: string | undefined
  readonly discoverable: boolean
  readonly owner_member_id: string | null
  readonly created_at: number
}

export interface RoomSearchRow extends RoomRow {
  readonly owner_name: string | null
}

const ACTIVE = 'dissolved_at IS NULL'

export function createRoomsRepo(db: Database) {
  return {
    insert(row: RoomInsert): void {
      db.query(
        'INSERT INTO rooms (id, name, display_name, description, discoverable, owner_member_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        row.id,
        row.name,
        row.display_name ?? null,
        row.description ?? null,
        row.discoverable ? 1 : 0,
        row.owner_member_id,
        row.created_at,
      )
    },
    byId(id: string): RoomRow | undefined {
      return db.query<RoomRow, [string]>('SELECT * FROM rooms WHERE id = ?').get(id) ?? undefined
    },
    activeByName(name: string): RoomRow | undefined {
      return (
        db.query<RoomRow, [string]>(`SELECT * FROM rooms WHERE name = ? AND ${ACTIVE}`).get(name) ?? undefined
      )
    },
    listActive(): readonly RoomRow[] {
      return db.query<RoomRow, []>(`SELECT * FROM rooms WHERE ${ACTIVE} ORDER BY created_at, id`).all()
    },
    /** Discoverable active rooms whose name, display name or owner name contains `q`. */
    search(q: string, limit: number): readonly RoomSearchRow[] {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      return db
        .query<RoomSearchRow, [string, string, string, number]>(
          `SELECT r.*, m.name AS owner_name FROM rooms r LEFT JOIN members m ON m.id = r.owner_member_id
           WHERE r.dissolved_at IS NULL AND r.discoverable = 1
             AND (r.name LIKE ? ESCAPE '\\' OR IFNULL(r.display_name, '') LIKE ? ESCAPE '\\' OR IFNULL(m.name, '') LIKE ? ESCAPE '\\')
           ORDER BY r.name LIMIT ?`,
        )
        .all(pattern, pattern, pattern, limit)
    },
    /** Allocates the next gap-free `seq` (call inside a transaction). */
    nextSeq(id: string): number {
      const row = db
        .query<{ head_seq: number }, [string]>(
          'UPDATE rooms SET head_seq = head_seq + 1 WHERE id = ? RETURNING head_seq',
        )
        .get(id)
      if (!row) throw new Error(`room ${id} not found`)
      return row.head_seq
    },
    dissolve(id: string, now: number): void {
      db.query('UPDATE rooms SET dissolved_at = ? WHERE id = ?').run(now, id)
    },
  }
}
export type RoomsRepo = ReturnType<typeof createRoomsRepo>
