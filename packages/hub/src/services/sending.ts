/** `msg.send`, `msg.reply` and `msg.progress` (§6.1–§6.4), idempotent on `client_msg_id`. */
import {
  DEFAULT_ASK_TTL_MS,
  MAX_ASK_TTL_MS,
  MAX_OPEN_ASKS_PER_ASKER_TARGET,
  MAX_OPEN_ASKS_PER_TARGET,
  type ParsedParamsOf,
  PeersError,
  type ResultInputOf,
} from '@agent-peers/protocol'
import type { AskRow } from '../storage/repos/asks'
import type { HandleRow } from '../storage/repos/handles'
import type { Access } from './access'
import type { Asks } from './asks'
import type { Effects, ServiceDeps } from './context'
import type { Messages } from './messages'
import type { RateLimiter } from './rate-limit'

type SendParams = ParsedParamsOf<'msg.send'>
type Sent = { readonly id: string; readonly seq: number }

export function createSending(
  deps: ServiceDeps,
  access: Access,
  asks: Asks,
  messages: Messages,
  limiter: RateLimiter,
) {
  const { repos } = deps

  const sender = (sessionId: string, handle: HandleRow) => {
    const member = repos.members.byId(handle.member_id)
    return { handle: handle.handle, member: member?.name ?? 'unknown', sessionId }
  }

  /** Validates the target and the §6.2 limits; returns the target's handle row. */
  const checkAskTarget = (params: SendParams, from: HandleRow): HandleRow => {
    const target = params.to?.[0] ?? ''
    const handle = repos.handles.get(params.room_id, target)
    if (!handle) throw new PeersError('target_not_found', `no @${target} in this room`)
    if (handle.handle === from.handle) throw new PeersError('invalid_params', 'cannot ask yourself')
    const holder = handle.session_id === null ? undefined : repos.sessions.byId(handle.session_id)
    if (holder?.outdated === 1)
      throw new PeersError('adapter_outdated', `@${target} runs an outdated adapter`)
    const online = holder !== undefined && holder.closed_at === null && holder.connection === 'online'
    if (params.require_online === true && !online)
      throw new PeersError('target_offline', `@${target} is offline`)
    if (repos.asks.countOpenTo(params.room_id, target) >= MAX_OPEN_ASKS_PER_TARGET) {
      throw new PeersError('target_busy', `@${target} has too many open asks`)
    }
    if (
      repos.asks.countOpenFromMemberTo(params.room_id, from.member_id, target) >=
      MAX_OPEN_ASKS_PER_ASKER_TARGET
    ) {
      throw new PeersError('rate_limited', `too many open asks to @${target}`)
    }
    return handle
  }

  const sendAsk = (
    fx: Effects,
    sessionId: string,
    params: SendParams,
    from: HandleRow,
  ): ResultInputOf<'msg.send'> => {
    const target = checkAskTarget(params, from)
    const who = sender(sessionId, from)
    const row = messages.append({
      roomId: params.room_id,
      kind: 'ask',
      text: params.text,
      from: who,
      to: [target.handle],
      clientMsgId: params.client_msg_id,
      ...(params.meta !== undefined ? { meta: params.meta } : {}),
    })
    const ttl = Math.min(params.ttl_ms ?? DEFAULT_ASK_TTL_MS, MAX_ASK_TTL_MS)
    repos.asks.insert({
      id: row.id,
      room_id: params.room_id,
      from_handle: from.handle,
      from_member_id: from.member_id,
      from_member: who.member,
      to_handle: target.handle,
      state: 'queued',
      expires_at: row.ts + ttl,
      created_at: row.ts,
    })
    const queued = repos.asks.byId(row.id) as AskRow
    const live = access.isLive(target.session_id)
    const ask = live ? asks.markDelivered(fx, queued) : queued
    if (!live) asks.publish(fx, queued)
    messages.fanOut(fx, row, ask)
    return { id: row.id, seq: row.seq, ask: { state: ask.state, expires_at: ask.expires_at } }
  }

  const send = (sessionId: string, params: SendParams): ResultInputOf<'msg.send'> =>
    deps.tx((fx) =>
      messages.idempotent(sessionId, params.client_msg_id, 'msg.send', () => {
        const from = access.requireHandle(sessionId, params.room_id)
        const grant = access.requireGrant(params.room_id, from.member_id)
        if (params.kind === 'ask' && grant.role === 'readonly') {
          throw new PeersError('forbidden', 'readonly members cannot ask')
        }
        limiter.enforce(from.member_id, 'messages')
        if (params.kind === 'ask') return sendAsk(fx, sessionId, params, from)
        const row = messages.append({
          roomId: params.room_id,
          kind: 'chat',
          text: params.text,
          from: sender(sessionId, from),
          to: params.to ?? [],
          clientMsgId: params.client_msg_id,
          ...(params.meta !== undefined ? { meta: params.meta } : {}),
        })
        messages.fanOut(fx, row)
        return { id: row.id, seq: row.seq, ask: null }
      }),
    )

  /** Only the assignee may reply or report progress on a working ask (§6.2). */
  const requireAssignee = (sessionId: string, askId: string): { ask: AskRow; handle: HandleRow } => {
    const ask = asks.requireAsk(askId)
    if (ask.assignee_session !== sessionId) throw new PeersError('forbidden', 'only the assignee may reply')
    if (ask.state !== 'working') throw new PeersError('ask_closed', `ask is ${ask.state}`)
    const handle = repos.handles.bySession(sessionId, ask.room_id)
    if (!handle) throw new PeersError('forbidden', 'the assignee no longer holds a handle in the room')
    return { ask, handle }
  }

  const followUp = (
    fx: Effects,
    sessionId: string,
    kind: 'reply' | 'progress',
    params: {
      readonly client_msg_id: string
      readonly ask_id: string
      readonly text: string
      readonly meta?: Record<string, unknown> | undefined
    },
    finish?: (ask: AskRow) => AskRow | undefined,
  ): Sent => {
    const { ask, handle } = requireAssignee(sessionId, params.ask_id)
    limiter.enforce(handle.member_id, 'messages')
    const row = messages.append({
      roomId: ask.room_id,
      kind,
      text: params.text,
      from: sender(sessionId, handle),
      to: [ask.from_handle],
      re: ask.id,
      clientMsgId: params.client_msg_id,
      ...(params.meta !== undefined ? { meta: params.meta } : {}),
    })
    const closed = finish?.(ask)
    messages.fanOut(fx, row, closed)
    return { id: row.id, seq: row.seq }
  }

  const reply = (sessionId: string, params: ParsedParamsOf<'msg.reply'>): Sent =>
    deps.tx((fx) =>
      messages.idempotent(sessionId, params.client_msg_id, 'msg.reply', () =>
        followUp(fx, sessionId, 'reply', params, (ask) =>
          asks.move(
            fx,
            ask.id,
            ['working'],
            params.state,
            params.state === 'failed' ? { reason: 'no_reply' } : {},
          ),
        ),
      ),
    )

  const progress = (sessionId: string, params: ParsedParamsOf<'msg.progress'>): Sent =>
    deps.tx((fx) =>
      messages.idempotent(sessionId, params.client_msg_id, 'msg.progress', () =>
        followUp(fx, sessionId, 'progress', params),
      ),
    )

  return { send, reply, progress }
}
export type Sending = ReturnType<typeof createSending>
