/** `invites`: at most one active invite per room; code stored as hash + last four (§8, §10.1). */
import type { Database } from 'bun:sqlite'
import type { Role } from '@agent-peers/protocol'

export type InviteCloseReason = 'rotated' | 'closed' | 'dissolved'

export interface InviteRow {
  readonly id: string
  readonly room_id: string
  readonly code_hash: string
  readonly last4: string
  readonly role: Role
  readonly created_by: string | null
  readonly created_at: number
  readonly closed_at: number | null
  readonly closed_reason: InviteCloseReason | null
}

export type InviteInsert = Omit<InviteRow, 'closed_at' | 'closed_reason'>

export function createInvitesRepo(db: Database) {
  return {
    insert(row: InviteInsert): void {
      db.query(
        'INSERT INTO invites (id, room_id, code_hash, last4, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.room_id, row.code_hash, row.last4, row.role, row.created_by, row.created_at)
    },
    byId(id: string): InviteRow | undefined {
      return db.query<InviteRow, [string]>('SELECT * FROM invites WHERE id = ?').get(id) ?? undefined
    },
    byHash(codeHash: string): InviteRow | undefined {
      return (
        db.query<InviteRow, [string]>('SELECT * FROM invites WHERE code_hash = ?').get(codeHash) ?? undefined
      )
    },
    active(roomId: string): InviteRow | undefined {
      return (
        db
          .query<InviteRow, [string]>('SELECT * FROM invites WHERE room_id = ? AND closed_at IS NULL')
          .get(roomId) ?? undefined
      )
    },
    latest(roomId: string): InviteRow | undefined {
      return (
        db
          .query<InviteRow, [string]>(
            'SELECT * FROM invites WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
          )
          .get(roomId) ?? undefined
      )
    },
    listActive(): readonly InviteRow[] {
      return db
        .query<InviteRow, []>('SELECT * FROM invites WHERE closed_at IS NULL ORDER BY created_at')
        .all()
    },
    close(id: string, now: number, reason: InviteCloseReason): void {
      db.query('UPDATE invites SET closed_at = ?, closed_reason = ? WHERE id = ? AND closed_at IS NULL').run(
        now,
        reason,
        id,
      )
    },
  }
}
export type InvitesRepo = ReturnType<typeof createInvitesRepo>
