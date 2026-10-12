/** `admin`: the single admin token, hashed (§8). */
import type { Database } from 'bun:sqlite'

export interface AdminRow {
  readonly token_hash: string
  readonly created_at: number
}

export function createAdminRepo(db: Database) {
  return {
    get(): AdminRow | undefined {
      return (
        db.query<AdminRow, []>('SELECT token_hash, created_at FROM admin WHERE id = 1').get() ?? undefined
      )
    },
    set(tokenHash: string, now: number): void {
      db.query(
        'INSERT INTO admin (id, token_hash, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at',
      ).run(tokenHash, now)
    },
  }
}
export type AdminRepo = ReturnType<typeof createAdminRepo>
