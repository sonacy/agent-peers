/** Row → wire conversions for messages, asks, rooms, knocks and invites. */
import type { AskRecord, Knock, Message, MessageMeta, Room } from '@agent-peers/protocol'
import type { AskRow } from '../storage/repos/asks'
import type { KnockRow } from '../storage/repos/knocks'
import type { MessageRow } from '../storage/repos/messages'
import type { RoomRow } from '../storage/repos/rooms'

function parseJson<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

export function toWireMessage(row: MessageRow, ask?: AskRow): Message {
  const from =
    row.from_handle !== null && row.from_member !== null
      ? {
          handle: row.from_handle,
          member: row.from_member,
          ...(row.from_session !== null ? { session_id: row.from_session } : {}),
        }
      : null
  return {
    id: row.id,
    client_msg_id: row.client_msg_id,
    room_id: row.room_id,
    seq: row.seq,
    from,
    kind: row.kind,
    to: parseJson<string[]>(row.to_json, []),
    text: row.text,
    re: row.re,
    meta: parseJson<MessageMeta | null>(row.meta_json, null),
    ask: ask
      ? {
          state: ask.state,
          expires_at: ask.expires_at,
          ...(ask.reason !== null ? { reason: ask.reason } : {}),
        }
      : null,
    ts: row.ts,
  }
}

export function toAskRecord(row: AskRow): AskRecord {
  return {
    ask_id: row.id,
    room_id: row.room_id,
    from_handle: row.from_handle,
    from_member: row.from_member,
    to_handle: row.to_handle,
    state: row.state,
    assignee_session: row.assignee_session,
    expires_at: row.expires_at,
    ...(row.reason !== null ? { reason: row.reason } : {}),
  }
}

export function toWireRoom(row: RoomRow, ownerName: string | undefined): Room {
  return {
    room_id: row.id,
    name: row.name,
    ...(row.display_name !== null ? { display_name: row.display_name } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    discoverable: row.discoverable === 1,
    ...(ownerName !== undefined ? { owner: ownerName } : {}),
    created_at: row.created_at,
  }
}

export function toWireKnock(row: KnockRow, memberName: string, previouslyRemoved: boolean): Knock {
  return {
    knock_id: row.id,
    room_id: row.room_id,
    member: memberName,
    member_id: row.member_id,
    note: row.note,
    state: row.state,
    created_at: row.created_at,
    expires_at: row.expires_at,
    decided_at: row.decided_at,
    previously_removed: previouslyRemoved,
  }
}
