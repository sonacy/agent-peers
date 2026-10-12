/** Messaging tools: peers_ask (with the inline wait), peers_send, peers_reply, peers_progress. */
import { PeersError, ReplyStateSchema } from '@agent-peers/protocol'
import { z } from 'zod'
import type { BridgeSession } from '../session/bridge-session'
import type { AskWaitResult } from '../session/signals'
import {
  type BridgeTool,
  clampSeconds,
  defineTool,
  ok,
  SessionKeyField,
  stripAt,
  type ToolContext,
} from './define'
import { parseTarget, resolveAskRoom, resolveRoom } from './resolve'

const TextArg = z
  .string()
  .min(1)
  .max(64 * 1024)
const AskIdArg = z.string().min(1).max(64).describe('The ask_id from the ASK envelope.')

const AskArgs = z.object({
  target: z.string().min(1).max(80).describe('@handle, or @handle@room when the handle is in several rooms.'),
  question: TextArg.describe('The question, exactly as the user wrote it.'),
  write: z.boolean().optional().describe('Mark it a write ask (a label for the receiver, not a permission).'),
  wait_seconds: z
    .number()
    .min(0)
    .max(170)
    .optional()
    .describe('How long to wait inline (default 45 s, capped).'),
  require_online: z.boolean().optional().describe('Fail at once when the target has no online session.'),
  ...SessionKeyField,
})

/** `pending · @work: online, busy, push` (ARCHITECTURE §3.1). */
async function pendingLine(session: BridgeSession, roomId: string, handle: string): Promise<string> {
  try {
    session.roster.setAll((await session.handle.peers(roomId)).members)
  } catch {
    // The state line is informational; the cached card (if any) is good enough.
  }
  const card = session.roster.card(roomId, handle)
  return card
    ? `pending · @${handle}: ${card.connection}, ${card.activity}, ${card.inject}`
    : `pending · @${handle}: offline`
}

async function inlineOutcome(
  session: BridgeSession,
  askId: string,
  result: AskWaitResult,
  maxChars: number,
): Promise<{ readonly text: string; readonly state: string } | undefined> {
  const progress = result.progress.map((m) => session.render(m, maxChars))
  if (result.reply) {
    await (await session.journal).markRead([result.reply.id])
    const text = [...progress, session.render(result.reply, maxChars)].join('\n\n')
    return { text, state: result.reply.ask?.state ?? 'answered' }
  }
  if (result.state) {
    const reason = result.reason ? ` (${result.reason})` : ''
    return { text: [...progress, `ask ${askId} ${result.state}${reason}`].join('\n\n'), state: result.state }
  }
  return undefined
}

async function ask(ctx: ToolContext, args: z.output<typeof AskArgs>) {
  const { rt } = ctx
  const session = await ctx.session()
  const target = parseTarget(args.target)
  const room = await resolveAskRoom(session, target)
  if (room.handle === target.handle) throw new PeersError('invalid_params', 'you cannot ask yourself')
  const sent = await session.handle.ask({
    room_id: room.room_id,
    to: target.handle,
    text: args.question,
    mode: args.write === true ? 'write' : 'read',
    ...(args.require_online === true ? { require_online: true } : {}),
  })
  session.rememberAsk(sent.id, { text: args.question, roomId: room.room_id, to: target.handle })
  session.waiters.watch(sent.id)
  const config = await rt.config()
  const waitMs = clampSeconds(args.wait_seconds, config.inline_wait_ms, rt.descriptor.inlineWaitCapMs)
  const result = await session.waiters.result(rt.clock, sent.id, waitMs, ctx.call.signal)
  const done = await inlineOutcome(session, sent.id, result, rt.descriptor.maxInjectChars)
  if (done) return ok(done.text, { ask_id: sent.id, state: done.state })
  const line = await pendingLine(session, room.room_id, target.handle)
  return ok(
    `${line}\nask_id ${sent.id}: the reply will be delivered to this session when it arrives (peers_inbox shows it too).`,
    { ask_id: sent.id, state: 'pending' },
  )
}

const SendArgs = z.object({
  text: TextArg.describe('The chat message.'),
  room: z.string().min(1).max(64).optional().describe('Room name (default: the only joined room).'),
  to: z.array(z.string().min(1).max(40)).max(16).optional().describe('Handles to mention.'),
  ...SessionKeyField,
})

async function send(ctx: ToolContext, args: z.output<typeof SendArgs>) {
  const session = await ctx.session()
  const room = resolveRoom(session, args.room)
  const to = args.to?.map(stripAt)
  const sent = await session.handle.send({ room_id: room.room_id, text: args.text, ...(to ? { to } : {}) })
  return ok(`sent to "${room.name ?? room.room_id}" (chat goes to inboxes; it never starts a turn)`, {
    id: sent.id,
  })
}

const ReplyArgs = z.object({
  ask_id: AskIdArg,
  text: TextArg.describe('Your answer (or why you decline).'),
  state: ReplyStateSchema.optional().describe('answered (default), declined or failed.'),
  ...SessionKeyField,
})

async function reply(ctx: ToolContext, args: z.output<typeof ReplyArgs>) {
  const session = await ctx.session()
  const state = args.state ?? 'answered'
  const outcome = await session.reply(args.ask_id, args.text, state)
  if (outcome === 'closed') return ok(`ask ${args.ask_id} is already closed; nothing was sent`)
  return ok(`reply sent (${state}) for ask ${args.ask_id}`, { ask_id: args.ask_id, state })
}

const ProgressArgs = z.object({ ask_id: AskIdArg, text: z.string().min(1).max(4000), ...SessionKeyField })

async function progress(ctx: ToolContext, args: z.output<typeof ProgressArgs>) {
  const session = await ctx.session()
  await session.handle.progress({ ask_id: args.ask_id, text: args.text })
  return ok(`progress sent for ask ${args.ask_id}`)
}

export const messagingTools: readonly BridgeTool[] = [
  defineTool({
    name: 'peers_ask',
    description:
      'Ask another agent session (@handle or @handle@room) a question and wait briefly for the reply. ' +
      'If it does not arrive in time, returns "pending" with the target state; the reply is delivered later.',
    schema: AskArgs,
    annotations: { openWorldHint: true },
    run: ask,
  }),
  defineTool({
    name: 'peers_send',
    description: 'Post a chat message to a room. Chat lands in inboxes and never starts a turn anywhere.',
    schema: SendArgs,
    annotations: { openWorldHint: true },
    run: send,
  }),
  defineTool({
    name: 'peers_reply',
    description:
      'Answer a peer ask this session received (the ask_id from its ASK envelope). Use state "declined" ' +
      'if you will not answer.',
    schema: ReplyArgs,
    annotations: { destructiveHint: false, openWorldHint: false, idempotentHint: true },
    run: reply,
  }),
  defineTool({
    name: 'peers_progress',
    description: 'Tell the asker you are still working on their ask (short status line).',
    schema: ProgressArgs,
    annotations: { destructiveHint: false, openWorldHint: false },
    run: progress,
  }),
]
