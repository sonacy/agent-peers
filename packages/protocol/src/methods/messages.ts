/** Message and ask methods (§6). */
import { z } from 'zod'
import { MAX_ASK_TTL_MS, MAX_HISTORY_LIMIT } from '../constants'
import { AskRecordSchema, AskStateSchema, MessageSchema, ReplyStateSchema } from '../message'
import {
  EmptySchema,
  IdSchema,
  MetaSchema,
  NameSchema,
  SeqSchema,
  TextSchema,
  TimestampSchema,
} from '../schema-util'

const sessionScoped = { session_id: IdSchema }
const ClientMsgIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'client_msg_id is a url-safe token')

export const MsgSendParamsSchema = z
  .object({
    ...sessionScoped,
    client_msg_id: ClientMsgIdSchema,
    room_id: IdSchema,
    kind: z.enum(['chat', 'ask']),
    to: z.array(NameSchema).max(64).optional(),
    text: TextSchema,
    meta: MetaSchema.optional(),
    ttl_ms: z.number().int().positive().max(MAX_ASK_TTL_MS).optional(),
    require_online: z.boolean().optional(),
  })
  .refine((p) => p.kind !== 'ask' || p.to?.length === 1, {
    message: 'an ask goes to exactly one handle',
    path: ['to'],
  })

const SentSchema = z.object({ id: IdSchema, seq: SeqSchema })

export const MsgSendResultSchema = SentSchema.extend({
  ask: z.object({ state: AskStateSchema, expires_at: TimestampSchema.optional() }).nullish(),
})

export const MsgReplyParamsSchema = z.object({
  ...sessionScoped,
  client_msg_id: ClientMsgIdSchema,
  ask_id: IdSchema,
  text: TextSchema,
  state: ReplyStateSchema,
  meta: MetaSchema.optional(),
})

export const MsgProgressParamsSchema = z.object({
  ...sessionScoped,
  client_msg_id: ClientMsgIdSchema,
  ask_id: IdSchema,
  text: TextSchema,
})

export const AskScopedSchema = z.object({ ...sessionScoped, ask_id: IdSchema })

export const MsgAckParamsSchema = z.object({ ...sessionScoped, room_id: IdSchema, seq: SeqSchema })

export const MsgHistoryParamsSchema = z.object({
  ...sessionScoped,
  room_id: IdSchema,
  before_seq: SeqSchema.optional(),
  limit: z.number().int().positive().max(MAX_HISTORY_LIMIT).optional(),
})

/**
 * `truncated: true` means older messages were left out so the result fits one frame (§1); page on
 * with `before_seq` (history) — for `ask.get`, the oldest follow-ups are the ones left out.
 */
const MessagesSchema = z.object({ messages: z.array(MessageSchema), truncated: z.boolean().optional() })

export const messageMethods = {
  'msg.send': { params: MsgSendParamsSchema, result: MsgSendResultSchema },
  'msg.reply': { params: MsgReplyParamsSchema, result: SentSchema },
  'msg.progress': { params: MsgProgressParamsSchema, result: SentSchema },
  'ask.claim': { params: AskScopedSchema, result: z.object({ ask: AskRecordSchema }) },
  'ask.cancel': { params: AskScopedSchema, result: EmptySchema },
  'ask.get': { params: AskScopedSchema, result: MessagesSchema.extend({ ask: AskRecordSchema }) },
  'msg.ack': { params: MsgAckParamsSchema, result: EmptySchema },
  'msg.history': { params: MsgHistoryParamsSchema, result: MessagesSchema },
} as const
