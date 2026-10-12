/** `messages`: the per-room log, ordered by a gap-free `seq` (§6.1, §6.3). */
import type { Database } from 'bun:sqlite'
import type { MessageKind } from '@agent-peers/protocol'

export interface MessageRow {
  readonly id: string
  readonly room_id: string
  readonly seq: number
  readonly client_msg_id: string | null
  readonly from_handle: string | null
  readonly from_member: string | null
  readonly from_session: string | null
  readonly kind: MessageKind
  readonly to_json: string
  readonly text: string
  readonly re: string | null
  readonly meta_json: string | null
  readonly ts: number
}

/** Kinds replayed from the chat cursor; asks are delivered separately (§6.2, §6.3). */
const REPLAY_KINDS = "('chat', 'reply', 'progress', 'system')"

export function createMessagesRepo(db: Database) {
  return {
    insert(row: MessageRow): void {
      db.query(
        `INSERT INTO messages (id, room_id, seq, client_msg_id, from_handle, from_member, from_session, kind, to_json, text, re, meta_json, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.room_id,
        row.seq,
        row.client_msg_id,
        row.from_handle,
        row.from_member,
        row.from_session,
        row.kind,
        row.to_json,
        row.text,
        row.re,
        row.meta_json,
        row.ts,
      )
    },
    byId(id: string): MessageRow | undefined {
      return db.query<MessageRow, [string]>('SELECT * FROM messages WHERE id = ?').get(id) ?? undefined
    },
    /** The newest `limit` replayable messages above `afterSeq`, oldest first, skipping `exceptHandle`'s own. */
    replay(roomId: string, afterSeq: number, exceptHandle: string, limit: number): readonly MessageRow[] {
      const rows = db
        .query<MessageRow, [string, number, string, number]>(
          `SELECT * FROM messages WHERE room_id = ? AND seq > ? AND kind IN ${REPLAY_KINDS}
             AND IFNULL(from_handle, '') <> ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(roomId, afterSeq, exceptHandle, limit)
      return rows.toReversed()
    },
    countUnread(roomId: string, afterSeq: number, exceptHandle: string): number {
      const row = db
        .query<{ n: number }, [string, number, string]>(
          `SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND seq > ? AND kind IN ${REPLAY_KINDS}
             AND IFNULL(from_handle, '') <> ?`,
        )
        .get(roomId, afterSeq, exceptHandle)
      return row?.n ?? 0
    },
    /** Up to `limit` messages below `beforeSeq` (all when undefined), oldest first. */
    history(roomId: string, beforeSeq: number | undefined, limit: number): readonly MessageRow[] {
      const rows = db
        .query<MessageRow, [string, number, number]>(
          'SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
        )
        .all(roomId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
      return rows.toReversed()
    },
    /** Replies and progress for an ask, oldest first. */
    forAsk(askId: string): readonly MessageRow[] {
      return db.query<MessageRow, [string]>('SELECT * FROM messages WHERE re = ? ORDER BY seq').all(askId)
    },
    lastTs(roomId: string): number | undefined {
      const row = db
        .query<{ ts: number | null }, [string]>('SELECT MAX(ts) AS ts FROM messages WHERE room_id = ?')
        .get(roomId)
      return row?.ts ?? undefined
    },
    /** Retention (§9): deletes messages (and their ask records) older than `cutoff`. */
    deleteOlderThan(cutoff: number): number {
      db.query('DELETE FROM asks WHERE id IN (SELECT id FROM messages WHERE ts < ?)').run(cutoff)
      return db.query('DELETE FROM messages WHERE ts < ?').run(cutoff).changes
    },
  }
}
export type MessagesRepo = ReturnType<typeof createMessagesRepo>
