/**
 * Asks (§6.2): hub-tracked delivery with a claim lease. Delivery is independent of the chat cursor;
 * whoever holds the target handle is offered every queued/delivered ask.
 */
import {
  type AskFailReason,
  type AskRecord,
  type AskState,
  isTerminalAskState,
  type Message,
  PeersError,
} from '@agent-peers/protocol'
import type { AskRow } from '../storage/repos/asks'
import type { Access, Actor } from './access'
import type { Effects, ServiceDeps } from './context'
import { encodedSize, FRAME_BUDGET_BYTES, fitNewest } from './frame-budget'
import { toAskRecord, toWireMessage } from './wire'

const OFFERABLE: readonly AskState[] = ['queued', 'delivered']
const OPEN: readonly AskState[] = ['queued', 'delivered', 'working']

export interface AskInput {
  readonly id: string
  readonly roomId: string
  readonly fromHandle: string
  readonly fromMemberId: string
  readonly fromMember: string
  readonly toHandle: string
  readonly expiresAt: number
}

export function createAsks(deps: ServiceDeps, access: Access) {
  const { repos } = deps

  /** `ask.updated` to the asker's handle holder (and the target's for cancel/expiry), plus the event. */
  const publish = (fx: Effects, row: AskRow) => {
    const params = {
      ask_id: row.id,
      state: row.state,
      ...(row.reason !== null ? { reason: row.reason } : {}),
    }
    const recipients = new Set<string>()
    const asker = repos.handles.get(row.room_id, row.from_handle)?.session_id
    if (asker) recipients.add(asker)
    if (row.state === 'cancelled' || row.state === 'expired') {
      const target = repos.handles.get(row.room_id, row.to_handle)?.session_id
      if (target) recipients.add(target)
    }
    for (const sessionId of recipients) fx.notify(sessionId, 'ask.updated', params)
    fx.emit({
      name: 'ask',
      data: { ask: toAskRecord(row) },
      memberIds: access.roomMemberIds(row.room_id),
      roomId: row.room_id,
    })
  }

  const move = (
    fx: Effects,
    id: string,
    from: readonly AskState[],
    state: AskState,
    extra: { assignee?: string | null; reason?: AskFailReason } = {},
  ) => {
    const next = {
      state,
      reason: extra.reason ?? null,
      ...(extra.assignee !== undefined ? { assignee_session: extra.assignee } : {}),
    }
    const row = repos.asks.transition(id, from, next, deps.now())
    if (row) publish(fx, row)
    return row
  }

  const offerMessage = (row: AskRow): Message | undefined => {
    const message = repos.messages.byId(row.id)
    return message ? toWireMessage(message, row) : undefined
  }

  /** Marks a queued ask delivered (the caller has just sent it to a live holder). */
  const markDelivered = (fx: Effects, row: AskRow): AskRow =>
    row.state === 'queued' ? (move(fx, row.id, ['queued'], 'delivered') ?? row) : row

  /**
   * §6.2: on claim, reattach or supersede into a handle, the holder is sent every queued or delivered
   * ask for it, with `replay: true`. Outdated sessions can't receive asks, so theirs stay queued.
   */
  const offer = (fx: Effects, sessionId: string, roomId: string, handle: string): number => {
    const session = repos.sessions.byId(sessionId)
    if (!session || session.outdated === 1) return 0
    const open = repos.asks.openTo(roomId, handle).filter((a) => OFFERABLE.includes(a.state))
    for (const ask of open) {
      const delivered = markDelivered(fx, ask)
      const message = offerMessage(delivered)
      if (message) fx.notify(sessionId, 'msg.new', { message, replay: true })
    }
    return open.length
  }

  const fail = (fx: Effects, rows: readonly AskRow[], reason: AskFailReason): readonly string[] =>
    rows.flatMap((row) => (move(fx, row.id, OPEN, 'failed', { reason }) ? [row.id] : []))

  /** The holder of a handle went away: delivered → queued, and its working asks fail (`target_lost`). */
  const holderLost = (fx: Effects, sessionId: string): void => {
    fail(fx, repos.asks.workingFor(sessionId), 'target_lost')
    for (const h of repos.handles.forSession(sessionId)) {
      for (const ask of repos.asks.openTo(h.room_id, h.handle)) {
        if (ask.state === 'delivered') move(fx, ask.id, ['delivered'], 'queued')
      }
    }
  }

  /** One handle moved away from `sessionId` (takeover): requeue delivered, fail its working asks. */
  const handleLost = (fx: Effects, roomId: string, handle: string, sessionId: string): readonly string[] => {
    const open = repos.asks.openTo(roomId, handle)
    for (const ask of open) {
      if (ask.state === 'delivered') move(fx, ask.id, ['delivered'], 'queued')
      if (ask.state === 'working' && ask.assignee_session === sessionId) {
        move(fx, ask.id, ['working'], 'failed', { reason: 'target_lost' })
      }
    }
    return open.map((a) => a.id)
  }

  const failInvolving = (fx: Effects, roomId: string, handle: string) =>
    fail(fx, repos.asks.openInvolving(roomId, handle), 'not_in_room')

  const failRoom = (fx: Effects, roomId: string) => fail(fx, repos.asks.openInRoom(roomId), 'not_in_room')

  const requireAsk = (askId: string): AskRow => {
    const ask = repos.asks.byId(askId)
    if (!ask) throw new PeersError('target_not_found', 'unknown ask')
    return ask
  }

  const claim = (sessionId: string, askId: string): AskRecord =>
    deps.tx((fx) => {
      const ask = requireAsk(askId)
      if (isTerminalAskState(ask.state)) throw new PeersError('ask_closed', `ask is ${ask.state}`)
      if (ask.state === 'working') {
        if (ask.assignee_session === sessionId) return toAskRecord(ask)
        throw new PeersError('ask_taken', 'another session is working on this ask')
      }
      if (repos.handles.get(ask.room_id, ask.to_handle)?.session_id !== sessionId) {
        throw new PeersError('forbidden', 'only the holder of the target handle may claim')
      }
      const row = move(fx, ask.id, OFFERABLE, 'working', { assignee: sessionId })
      if (!row) throw new PeersError('ask_taken', 'the ask changed concurrently')
      return toAskRecord(row)
    })

  const cancel = (actor: Actor, askId: string): void =>
    deps.tx((fx) => {
      const ask = requireAsk(askId)
      if (actor.kind !== 'admin' && actor.memberId !== ask.from_member_id) {
        throw new PeersError('forbidden', 'only the asking member may cancel')
      }
      if (isTerminalAskState(ask.state)) throw new PeersError('ask_closed', `ask is ${ask.state}`)
      if (!move(fx, ask.id, OPEN, 'cancelled')) throw new PeersError('ask_closed', 'ask already closed')
    })

  /**
   * The ask, its question and follow-ups. Under one frame (§1): when the follow-ups don't fit, the
   * oldest are left out (`truncated`) and the newest, which carry the final state, are kept.
   */
  const get = (
    actor: Actor,
    askId: string,
  ): { readonly ask: AskRecord; readonly messages: readonly Message[]; readonly truncated?: true } => {
    const ask = requireAsk(askId)
    if (actor.kind !== 'admin') access.requireGrant(ask.room_id, actor.memberId)
    const record = toAskRecord(ask)
    const row = repos.messages.byId(ask.id)
    const question = row ? [toWireMessage(row, ask)] : []
    const budget = FRAME_BUDGET_BYTES - encodedSize({ ask: record, messages: question })
    const followups = fitNewest(
      repos.messages.forAsk(ask.id).map((m) => toWireMessage(m)),
      budget,
    )
    return {
      ask: record,
      messages: [...question, ...followups.messages],
      ...(followups.truncated ? { truncated: true as const } : {}),
    }
  }

  /** TTL sweeper: open asks past `expires_at` become `expired`. */
  const expireDue = (): number =>
    deps.tx(
      (fx) =>
        repos.asks
          .due(deps.now())
          .filter((a) => move(fx, a.id, OPEN, 'expired', { reason: 'expired' }) !== undefined).length,
    )

  return {
    publish,
    move,
    offer,
    markDelivered,
    holderLost,
    handleLost,
    failInvolving,
    failRoom,
    claim,
    cancel,
    get,
    expireDue,
    requireAsk,
  }
}
export type Asks = ReturnType<typeof createAsks>
