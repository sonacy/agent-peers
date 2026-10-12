/** Messages (§6.1, §6.3, §6.4): gap-free seq, fan-out, cursor replay, history and acks. */
import {
  DEDUP_WINDOW_MS,
  type Message,
  type MessageKind,
  type ParsedParamsOf,
  PeersError,
  REPLAY_LIMIT,
} from '@agent-peers/protocol'
import type { AskRow } from '../storage/repos/asks'
import type { MessageRow } from '../storage/repos/messages'
import type { Access } from './access'
import type { Asks } from './asks'
import type { Effects, ServiceDeps } from './context'
import { encodedSize, type FittedPage, FRAME_BUDGET_BYTES, fitNewest } from './frame-budget'
import { toWireMessage } from './wire'

const DEFAULT_HISTORY_LIMIT = 50

export interface Sender {
  readonly handle: string
  readonly member: string
  readonly sessionId?: string
}

export interface AppendInput {
  readonly roomId: string
  readonly kind: MessageKind
  readonly text: string
  readonly from?: Sender
  readonly to?: readonly string[]
  readonly re?: string
  readonly meta?: Readonly<Record<string, unknown>>
  readonly clientMsgId?: string
}

export function createMessages(deps: ServiceDeps, access: Access, asks: Asks) {
  const { repos } = deps

  /** Inserts a message at the room's next seq (inside the caller's transaction). */
  const append = (input: AppendInput, id: string = deps.newId()): MessageRow => {
    const row: MessageRow = {
      id,
      room_id: input.roomId,
      seq: repos.rooms.nextSeq(input.roomId),
      client_msg_id: input.clientMsgId ?? null,
      from_handle: input.from?.handle ?? null,
      from_member: input.from?.member ?? null,
      from_session: input.from?.sessionId ?? null,
      kind: input.kind,
      to_json: JSON.stringify(input.to ?? []),
      text: input.text,
      re: input.re ?? null,
      meta_json: input.meta === undefined ? null : JSON.stringify(input.meta),
      ts: deps.now(),
    }
    // Text and meta are capped separately; JSON escaping can still push the total past one frame,
    // and a message that can't be fanned out must not be stored (§1).
    if (encodedSize(toWireMessage(row)) > FRAME_BUDGET_BYTES)
      throw new PeersError('payload_too_large', 'the encoded message does not fit one frame')
    repos.messages.insert(row)
    return row
  }

  /**
   * `msg.new` to every live holder in the room except the sender (or `exceptSessionId`), plus the
   * dashboard event.
   */
  const fanOut = (fx: Effects, row: MessageRow, ask?: AskRow, exceptSessionId?: string): Message => {
    const message = toWireMessage(row, ask)
    access.notifyRoom(
      fx,
      row.room_id,
      'msg.new',
      { message },
      exceptSessionId ?? row.from_session ?? undefined,
    )
    fx.emit({
      name: 'message',
      data: { message },
      memberIds: access.roomMemberIds(row.room_id),
      roomId: row.room_id,
    })
    return message
  }

  /** A system notice; `exceptSessionId` skips a joiner, which must see nothing before `replay.done` (§6.3). */
  const system = (fx: Effects, roomId: string, text: string, exceptSessionId?: string): MessageRow => {
    const row = append({ roomId, kind: 'system', text })
    fanOut(fx, row, undefined, exceptSessionId)
    return row
  }

  /** The chat cursor for (room, handle); a new handle starts at the room head (§6.3). */
  const cursorFor = (roomId: string, handle: string): number => {
    const existing = repos.cursors.get(roomId, handle)
    if (existing !== undefined) return existing
    const head = access.requireRoom(roomId).head_seq
    repos.cursors.set(roomId, handle, head)
    return head
  }

  /** Capped chat replay above the cursor, then `replay.done` (§6.3). */
  const replay = (fx: Effects, sessionId: string, roomId: string, handle: string): void => {
    const cursor = cursorFor(roomId, handle)
    for (const row of repos.messages.replay(roomId, cursor, handle, REPLAY_LIMIT)) {
      fx.notify(sessionId, 'msg.new', {
        message: toWireMessage(row, repos.asks.byId(row.re ?? '')),
        replay: true,
      })
    }
    fx.notify(sessionId, 'replay.done', { room_id: roomId, head_seq: access.requireRoom(roomId).head_seq })
  }

  /** On claim, reattach or supersede: open asks first, then the capped chat replay. */
  const deliverRoom = (sessionId: string, roomId: string, handle: string): void =>
    deps.tx((fx) => {
      asks.offer(fx, sessionId, roomId, handle)
      replay(fx, sessionId, roomId, handle)
    })

  /** Dedupes on (session identity, client_msg_id) for 10 minutes (§6.4). */
  const idempotent = <T>(sessionId: string, clientMsgId: string, method: string, run: () => T): T => {
    const prior = repos.idempotency.get(sessionId, clientMsgId, deps.now() - DEDUP_WINDOW_MS)
    if (prior && prior.method === method) return JSON.parse(prior.result_json) as T
    const result = run()
    repos.idempotency.put(sessionId, clientMsgId, method, result, deps.now())
    return result
  }

  const ack = (sessionId: string, params: ParsedParamsOf<'msg.ack'>): void =>
    deps.tx(() => {
      const handle = access.requireHandle(sessionId, params.room_id)
      const head = access.requireRoom(params.room_id).head_seq
      const current = cursorFor(params.room_id, handle.handle)
      const next = Math.min(params.seq, head)
      if (next > current) repos.cursors.set(params.room_id, handle.handle, next)
    })

  /** A page of history, oldest first, cut to fit one frame (`truncated`: page on with `before_seq`). */
  const history = (
    memberId: string | undefined,
    params: { readonly room_id: string; readonly before_seq?: number; readonly limit?: number },
  ): FittedPage => {
    access.requireRoom(params.room_id)
    if (memberId !== undefined) access.requireGrant(params.room_id, memberId)
    const rows = repos.messages.history(
      params.room_id,
      params.before_seq,
      params.limit ?? DEFAULT_HISTORY_LIMIT,
    )
    return fitNewest(
      rows.map((row) => toWireMessage(row, row.kind === 'ask' ? repos.asks.byId(row.id) : undefined)),
    )
  }

  const unread = (roomId: string, handle: string): number =>
    repos.messages.countUnread(
      roomId,
      repos.cursors.get(roomId, handle) ?? access.requireRoom(roomId).head_seq,
      handle,
    )

  return { append, fanOut, system, replay, deliverRoom, idempotent, ack, history, unread, cursorFor }
}
export type Messages = ReturnType<typeof createMessages>
