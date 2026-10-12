/** `member_tokens`: SHA-256 hashes of member tokens only (§8). */
import type { Database } from 'bun:sqlite'

export interface MemberTokenRow {
  readonly token_hash: string
  readonly member_id: string
  readonly created_at: number
  readonly revoked_at: number | null
}

export function createMemberTokensRepo(db: Database) {
  return {
    insert(tokenHash: string, memberId: string, now: number): void {
      db.query('INSERT INTO member_tokens (token_hash, member_id, created_at) VALUES (?, ?, ?)').run(
        tokenHash,
        memberId,
        now,
      )
    },
    active(tokenHash: string): MemberTokenRow | undefined {
      return (
        db
          .query<MemberTokenRow, [string]>(
            'SELECT * FROM member_tokens WHERE token_hash = ? AND revoked_at IS NULL',
          )
          .get(tokenHash) ?? undefined
      )
    },
    revokeAll(memberId: string, now: number): number {
      return db
        .query('UPDATE member_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL')
        .run(now, memberId).changes
    },
  }
}
export type MemberTokensRepo = ReturnType<typeof createMemberTokensRepo>
