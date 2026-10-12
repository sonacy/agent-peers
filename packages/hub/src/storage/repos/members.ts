/** `members`: identities behind member tokens (§2). */
import type { Database } from 'bun:sqlite'

export interface MemberRow {
  readonly id: string
  readonly name: string
  readonly created_at: number
}

export function createMembersRepo(db: Database) {
  return {
    insert(row: MemberRow): MemberRow {
      db.query('INSERT INTO members (id, name, created_at) VALUES (?, ?, ?)').run(
        row.id,
        row.name,
        row.created_at,
      )
      return row
    },
    byId(id: string): MemberRow | undefined {
      return db.query<MemberRow, [string]>('SELECT * FROM members WHERE id = ?').get(id) ?? undefined
    },
    byName(name: string): MemberRow | undefined {
      return db.query<MemberRow, [string]>('SELECT * FROM members WHERE name = ?').get(name) ?? undefined
    },
    list(): readonly MemberRow[] {
      return db.query<MemberRow, []>('SELECT * FROM members ORDER BY created_at, id').all()
    },
  }
}
export type MembersRepo = ReturnType<typeof createMembersRepo>
