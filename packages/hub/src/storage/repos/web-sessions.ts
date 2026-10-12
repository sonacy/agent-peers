/** `web_sessions`: dashboard cookies, stored hashed (§9). */
import type { Database } from 'bun:sqlite'

export interface WebSessionRow {
  readonly token_hash: string
  readonly member_id: string
  readonly created_at: number
  readonly expires_at: number
}

export function createWebSessionsRepo(db: Database) {
  return {
    insert(row: WebSessionRow): void {
      db.query(
        'INSERT INTO web_sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run(row.token_hash, row.member_id, row.created_at, row.expires_at)
    },
    get(tokenHash: string): WebSessionRow | undefined {
      return (
        db.query<WebSessionRow, [string]>('SELECT * FROM web_sessions WHERE token_hash = ?').get(tokenHash) ??
        undefined
      )
    },
    delete(tokenHash: string): void {
      db.query('DELETE FROM web_sessions WHERE token_hash = ?').run(tokenHash)
    },
    deleteForMember(memberId: string): void {
      db.query('DELETE FROM web_sessions WHERE member_id = ?').run(memberId)
    },
    deleteExpired(now: number): number {
      return db.query('DELETE FROM web_sessions WHERE expires_at <= ?').run(now).changes
    },
  }
}
export type WebSessionsRepo = ReturnType<typeof createWebSessionsRepo>
