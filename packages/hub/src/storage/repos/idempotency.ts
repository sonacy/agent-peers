/** `idempotency`: `client_msg_id` results per session identity, kept for the dedup window (§6.4). */
import type { Database } from 'bun:sqlite'

export interface IdempotencyRow {
  readonly method: string
  readonly result_json: string
  readonly created_at: number
}

export function createIdempotencyRepo(db: Database) {
  return {
    get(sessionId: string, clientMsgId: string, since: number): IdempotencyRow | undefined {
      return (
        db
          .query<IdempotencyRow, [string, string, number]>(
            'SELECT method, result_json, created_at FROM idempotency WHERE session_id = ? AND client_msg_id = ? AND created_at > ?',
          )
          .get(sessionId, clientMsgId, since) ?? undefined
      )
    },
    put(sessionId: string, clientMsgId: string, method: string, result: unknown, now: number): void {
      db.query(
        'INSERT OR REPLACE INTO idempotency (session_id, client_msg_id, method, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(sessionId, clientMsgId, method, JSON.stringify(result), now)
    },
    deleteOlderThan(cutoff: number): number {
      return db.query('DELETE FROM idempotency WHERE created_at <= ?').run(cutoff).changes
    },
  }
}
export type IdempotencyRepo = ReturnType<typeof createIdempotencyRepo>
