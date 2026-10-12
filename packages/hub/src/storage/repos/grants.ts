/** `grants`: per (room, member) role, revocation and the kicked flag (§2, §8, §10.3). */
import type { Database } from 'bun:sqlite'
import type { Role } from '@agent-peers/protocol'

export interface GrantRow {
  readonly room_id: string
  readonly member_id: string
  readonly role: Role
  readonly created_at: number
  readonly revoked_at: number | null
  readonly kicked: number
  readonly kicked_at: number | null
}

export interface GrantWithName extends GrantRow {
  readonly member_name: string
}

const WITH_NAME = 'SELECT g.*, m.name AS member_name FROM grants g JOIN members m ON m.id = g.member_id'

export function createGrantsRepo(db: Database) {
  return {
    /** Creates or re-activates a grant (clears revocation and the kicked flag). */
    upsert(roomId: string, memberId: string, role: Role, now: number): void {
      db.query(
        `INSERT INTO grants (room_id, member_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, member_id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at,
           revoked_at = NULL, kicked = 0, kicked_at = NULL`,
      ).run(roomId, memberId, role, now)
    },
    get(roomId: string, memberId: string): GrantRow | undefined {
      return (
        db
          .query<GrantRow, [string, string]>('SELECT * FROM grants WHERE room_id = ? AND member_id = ?')
          .get(roomId, memberId) ?? undefined
      )
    },
    activeForRoom(roomId: string): readonly GrantWithName[] {
      return db
        .query<GrantWithName, [string]>(
          `${WITH_NAME} WHERE g.room_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at`,
        )
        .all(roomId)
    },
    activeForMember(memberId: string): readonly GrantRow[] {
      return db
        .query<GrantRow, [string]>(
          `SELECT g.* FROM grants g JOIN rooms r ON r.id = g.room_id
           WHERE g.member_id = ? AND g.revoked_at IS NULL AND r.dissolved_at IS NULL ORDER BY g.created_at`,
        )
        .all(memberId)
    },
    kickedForRoom(roomId: string): readonly GrantWithName[] {
      return db
        .query<GrantWithName, [string]>(
          `${WITH_NAME} WHERE g.room_id = ? AND g.kicked = 1 ORDER BY g.kicked_at`,
        )
        .all(roomId)
    },
    revoke(roomId: string, memberId: string, now: number, kicked: boolean): void {
      db.query(
        'UPDATE grants SET revoked_at = ?, kicked = ?, kicked_at = ? WHERE room_id = ? AND member_id = ?',
      ).run(now, kicked ? 1 : 0, kicked ? now : null, roomId, memberId)
    },
    revokeAllInRoom(roomId: string, now: number): void {
      db.query('UPDATE grants SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL').run(now, roomId)
    },
    countActive(roomId: string): number {
      const row = db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM grants WHERE room_id = ? AND revoked_at IS NULL',
        )
        .get(roomId)
      return row?.n ?? 0
    },
  }
}
export type GrantsRepo = ReturnType<typeof createGrantsRepo>
