/** `knocks`: requests to join discoverable rooms (§10.2). */
import type { Database } from 'bun:sqlite'
import type { KnockState } from '@agent-peers/protocol'

export interface KnockRow {
  readonly id: string
  readonly room_id: string
  readonly member_id: string
  readonly note: string | null
  readonly state: KnockState
  readonly created_at: number
  readonly expires_at: number
  readonly decided_at: number | null
}

export type KnockInsert = Omit<KnockRow, 'state' | 'decided_at'>

export function createKnocksRepo(db: Database) {
  return {
    insert(row: KnockInsert): void {
      db.query(
        "INSERT INTO knocks (id, room_id, member_id, note, state, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      ).run(row.id, row.room_id, row.member_id, row.note, row.created_at, row.expires_at)
    },
    byId(id: string): KnockRow | undefined {
      return db.query<KnockRow, [string]>('SELECT * FROM knocks WHERE id = ?').get(id) ?? undefined
    },
    pending(roomId: string, memberId: string): KnockRow | undefined {
      return (
        db
          .query<KnockRow, [string, string]>(
            "SELECT * FROM knocks WHERE room_id = ? AND member_id = ? AND state = 'pending'",
          )
          .get(roomId, memberId) ?? undefined
      )
    },
    lastDeclined(roomId: string, memberId: string): KnockRow | undefined {
      return (
        db
          .query<KnockRow, [string, string]>(
            "SELECT * FROM knocks WHERE room_id = ? AND member_id = ? AND state = 'declined' ORDER BY decided_at DESC LIMIT 1",
          )
          .get(roomId, memberId) ?? undefined
      )
    },
    pendingForRoom(roomId: string): readonly KnockRow[] {
      return db
        .query<KnockRow, [string]>(
          "SELECT * FROM knocks WHERE room_id = ? AND state = 'pending' ORDER BY created_at",
        )
        .all(roomId)
    },
    pendingForMember(memberId: string): readonly KnockRow[] {
      return db
        .query<KnockRow, [string]>(
          "SELECT * FROM knocks WHERE member_id = ? AND state = 'pending' ORDER BY created_at",
        )
        .all(memberId)
    },
    /** Compare-and-set from `pending`; true when this call made the change. */
    decide(id: string, state: KnockState, now: number): boolean {
      return (
        db
          .query("UPDATE knocks SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'")
          .run(state, now, id).changes === 1
      )
    },
    duePending(now: number): readonly KnockRow[] {
      return db
        .query<KnockRow, [number]>("SELECT * FROM knocks WHERE state = 'pending' AND expires_at <= ?")
        .all(now)
    },
    deletePendingForRoom(roomId: string): number {
      return db.query("DELETE FROM knocks WHERE room_id = ? AND state = 'pending'").run(roomId).changes
    },
  }
}
export type KnocksRepo = ReturnType<typeof createKnocksRepo>
