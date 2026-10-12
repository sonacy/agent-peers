/**
 * peers_inbox (the fallback for every tier) and peers_wait (listen mode, ARCHITECTURE §6.3). Every
 * message is shown inside its nonce envelope (PROTOCOL §7.2). Asks are claimed and handed out
 * through the injection queue before they are shown, so they always run inside a (gated) peer turn,
 * including over-budget and stale ones the local user reads here. Both tools return the envelopes
 * to the agent directly, so the hand-outs are final (never re-delivered on lease expiry).
 */
import type { JournalEntry } from '@agent-peers/core'
import type { DeepReadonly, Message } from '@agent-peers/protocol'
import { z } from 'zod'
import type { BridgeSession } from '../session/bridge-session'
import type { PeerMessage } from '../session/signals'
import { type BridgeTool, clampSeconds, defineTool, ok, SessionKeyField, type ToolContext } from './define'

/** Tool output is not bound by a hook's output cap; keep each envelope within one message's size. */
export const INBOX_MAX_CHARS = 70_000
/** At most this many messages per inbox call; the rest stay unread. */
export const INBOX_PAGE = 20

const asMessage = (entry: JournalEntry): PeerMessage => entry.message as unknown as DeepReadonly<Message>

async function showOne(session: BridgeSession, askId: string): Promise<string> {
  const journal = await session.journal
  const entry = journal.get(askId)
  if (entry) return session.render(asMessage(entry), INBOX_MAX_CHARS)
  const { messages } = await session.handle.getAsk(askId)
  return messages.map((m) => session.render(m, INBOX_MAX_CHARS)).join('\n\n')
}

/**
 * Pending queue items, asks claimed by the hand-out. Asks held in the inbox (over budget, stale
 * replay) are handed out too now that the local user reads them, but through the queue, so they
 * join a gated peer turn instead of reaching the model unguarded.
 */
async function takePending(
  ctx: ToolContext,
  session: BridgeSession,
): Promise<readonly { id: string; envelope: string }[]> {
  session.queue.reopenInboxOnly()
  const taken: { id: string; envelope: string }[] = []
  while (taken.length < INBOX_PAGE) {
    const out = await session.handOut('take', INBOX_MAX_CHARS, { inline: true })
    if (!out) break
    taken.push({ id: out.item.id, envelope: out.envelope })
  }
  session.turns.bind(ctx.call.turnId)
  return taken
}

async function inbox(ctx: ToolContext, args: { ask_id?: string | undefined }) {
  const session = await ctx.session()
  if (args.ask_id !== undefined) return ok(await showOne(session, args.ask_id))
  await session.settled()
  const pending = await takePending(ctx, session)
  const seen = new Set(pending.map((p) => p.id))
  const journal = await session.journal
  const others = journal.unread().filter((e) => !session.isForMe(asMessage(e)))
  await journal.markRead(others.map((e) => e.message.id))
  const unread = (await session.unread())
    .filter((e) => !seen.has(e.message.id))
    .slice(0, INBOX_PAGE - pending.length)
  const envelopes = [
    ...pending.map((p) => p.envelope),
    ...unread.map((e) => session.render(asMessage(e), INBOX_MAX_CHARS)),
  ]
  await journal.markRead(unread.map((e) => e.message.id))
  const more = (await session.unread()).length
  const dnd = session.accepting
    ? ''
    : '\ndo-not-disturb is on: new asks are held until you switch it off (peers_status).'
  if (envelopes.length === 0) return ok(`[agent-peers] inbox: nothing new${dnd}`, { count: 0 })
  const header = `[agent-peers] inbox: ${envelopes.length} new${more > 0 ? ` (${more} more: call peers_inbox again)` : ''}`
  return ok(`${header}${dnd}\n\n${envelopes.join('\n\n')}`, { count: envelopes.length })
}

const GATE_INACTIVE_NOTE =
  ' Peer asks are held for peers_inbox: the tool gate is not active in this session (hooks not ' +
  'running or not trusted), so asks never run unattended. Ask your user to read them with peers_inbox.'

/**
 * Listen mode. The model asks for the next message during its own turn, so a hand-out is fine while
 * busy (unlike the asyncRewake waiter). Asks are not handed out when the gate is inactive.
 */
async function wait(ctx: ToolContext, args: { timeout_seconds?: number | undefined }) {
  const { rt } = ctx
  const session = await ctx.session()
  const cap = rt.descriptor.waitCapMs
  const deadline = rt.clock.now() + clampSeconds(args.timeout_seconds, cap, cap)
  session.beginListen()
  try {
    for (;;) {
      if (session.ended) break
      const out = await session.handOut('wait', rt.descriptor.maxInjectChars, { inline: true })
      if (out) {
        session.turns.bind(ctx.call.turnId)
        return ok(out.envelope, { inject_id: out.inject_id, kind: out.item.kind })
      }
      const left = deadline - rt.clock.now()
      if (left <= 0) break
      if ((await session.changes.wait(rt.clock, left, ctx.call.signal)) === 'aborted') break
    }
  } finally {
    session.endListen()
  }
  const held = session.heldAsks()
  return ok(
    `[agent-peers] no peer message yet. Call peers_wait again to keep listening.${held > 0 ? GATE_INACTIVE_NOTE : ''}`,
    { inject_id: null, ...(held > 0 ? { held_asks: held, reason: 'gate_inactive' } : {}) },
  )
}

export const inboxTools: readonly BridgeTool[] = [
  defineTool({
    name: 'peers_inbox',
    description:
      'Show unread agent-peers messages and open asks for this session (each inside an untrusted-input ' +
      'envelope). Pass ask_id to show one message in full.',
    schema: z.object({
      ask_id: z.string().min(1).max(64).optional().describe('Show this ask or message in full.'),
      ...SessionKeyField,
    }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: inbox,
  }),
  defineTool({
    name: 'peers_wait',
    description:
      'Listen mode: wait (up to ~50 s) for the next peer ask or reply and return it. Handle it, then call ' +
      'peers_wait again until the listening time is up.',
    schema: z.object({
      timeout_seconds: z.number().min(0).max(50).optional().describe('Seconds to wait (max 50).'),
      ...SessionKeyField,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: wait,
  }),
]
