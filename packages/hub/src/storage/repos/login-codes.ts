/** `login_codes`: one-time dashboard login codes, hashed, single use (§6.4 `dashboard.login`). */
import type { Database } from 'bun:sqlite'

export interface LoginCodeRow {
  readonly code_hash: string
  readonly member_id: string
  readonly created_at: number
  readonly expires_at: number
  readonly used_at: number | null
}

export function createLoginCodesRepo(db: Database) {
  return {
    insert(row: Omit<LoginCodeRow, 'used_at'>): void {
      db.query(
        'INSERT INTO login_codes (code_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run(row.code_hash, row.member_id, row.created_at, row.expires_at)
    },
    get(codeHash: string): LoginCodeRow | undefined {
      return (
        db.query<LoginCodeRow, [string]>('SELECT * FROM login_codes WHERE code_hash = ?').get(codeHash) ??
        undefined
      )
    },
    /** Compare-and-set: true only for the first use of an unexpired code. */
    consume(codeHash: string, now: number): boolean {
      return (
        db
          .query(
            'UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
          )
          .run(now, codeHash, now).changes === 1
      )
    },
    deleteExpired(now: number): number {
      return db.query('DELETE FROM login_codes WHERE expires_at <= ?').run(now).changes
    },
  }
}
export type LoginCodesRepo = ReturnType<typeof createLoginCodesRepo>
