/** `audit`: append-only record of administrative and membership actions. */
import type { Database } from 'bun:sqlite'

export interface AuditRow {
  readonly id: number
  readonly ts: number
  readonly actor: string
  readonly action: string
  readonly room_id: string | null
  readonly detail_json: string | null
}

export interface AuditInput {
  readonly ts: number
  readonly actor: string
  readonly action: string
  readonly roomId?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export function createAuditRepo(db: Database) {
  return {
    insert(entry: AuditInput): void {
      db.query('INSERT INTO audit (ts, actor, action, room_id, detail_json) VALUES (?, ?, ?, ?, ?)').run(
        entry.ts,
        entry.actor,
        entry.action,
        entry.roomId ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      )
    },
    list(limit = 100, roomId?: string): readonly AuditRow[] {
      if (roomId !== undefined) {
        return db
          .query<AuditRow, [string, number]>('SELECT * FROM audit WHERE room_id = ? ORDER BY id DESC LIMIT ?')
          .all(roomId, limit)
      }
      return db.query<AuditRow, [number]>('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    },
  }
}
export type AuditRepo = ReturnType<typeof createAuditRepo>
