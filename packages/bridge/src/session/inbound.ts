/**
 * Inbound routing for one session (PROTOCOL §6.3, §7): every message is journaled first (then
 * acked), and only then routed to an inline `peers_ask` wait, the injection queue or the inbox.
 * Asks are visible to every room member (§6.1), so only those addressed to this session's handle
 * are queued.
 */
import type { JournalMessage, SessionHandle, SessionJournal } from '@agent-peers/core'
import { type AskState, isTerminalAskState, type NotificationMap } from '@agent-peers/protocol'
import type { AskWaiters, PeerMessage } from './signals'

export interface InboundHost {
  readonly handle: SessionHandle
  readonly journal: Promise<SessionJournal>
  readonly waiters: AskWaiters
  myHandle(roomId: string): string | undefined
  /** True for asks this session sent (their replies are routed back here). */
  sentAsk(askId: string): unknown
  enqueue(message: PeerMessage, replay: boolean): void
  log(line: string): void
}

/** Addressed to this session: an ask/reply/progress `to` its handle, or the answer to one of its asks. */
export function addressedTo(host: InboundHost, message: PeerMessage): boolean {
  const handle = host.myHandle(message.room_id)
  if (handle !== undefined && message.to.includes(handle)) return true
  const re = message.re ?? undefined
  return message.kind !== 'ask' && re !== undefined && host.sentAsk(re) !== undefined
}

/** Chat and system notices are for everyone; asks, replies and progress only for their parties. */
export function isForMe(host: InboundHost, message: PeerMessage): boolean {
  if (message.kind !== 'ask' && message.kind !== 'reply' && message.kind !== 'progress') return true
  return addressedTo(host, message)
}

/** An ask journaled earlier (before a restart) that was never injected and is not closed. */
function stillOpen(journal: SessionJournal, id: string): boolean {
  const state = journal.askStatus(id)?.state as AskState | undefined
  const terminal = state !== undefined && isTerminalAskState(state)
  return journal.injection(id).injected_via === undefined && !terminal
}

function ack(host: InboundHost, journal: SessionJournal, roomId: string, seq: number): void {
  host.handle
    .ack(roomId, seq)
    .then(() => journal.markAcked(roomId, seq))
    .catch((error: unknown) => host.log(`msg.ack failed: ${String(error)}`))
}

export async function routeMessage(host: InboundHost, message: PeerMessage, replay: boolean): Promise<void> {
  const journal = await host.journal
  const { added } = await journal.record(message as JournalMessage, { replay })
  ack(host, journal, message.room_id, message.seq)
  const own = message.from?.session_id
  if (own !== undefined && own === host.handle.view.sessionId) {
    if (added) await journal.markRead([message.id])
    return
  }
  const mine = addressedTo(host, message)
  if (message.kind === 'ask') {
    if (mine && (added || stillOpen(journal, message.id))) host.enqueue(message, replay)
    return
  }
  if (message.kind === 'reply' && message.re)
    await journal.setAskState(message.re, message.ask?.state ?? 'answered')
  if (!added || !mine || (message.kind !== 'reply' && message.kind !== 'progress')) return
  if (host.waiters.offer(message)) await journal.markRead([message.id])
  else if (message.kind === 'reply') host.enqueue(message, replay)
}

export async function routeAskUpdate(
  host: InboundHost,
  update: NotificationMap['ask.updated'],
): Promise<void> {
  await (await host.journal).setAskState(update.ask_id, update.state, update.reason)
  host.waiters.settle(update.ask_id, update.state, update.reason)
}
