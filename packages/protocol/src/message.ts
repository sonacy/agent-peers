/** Messages (§6.1) and asks (§6.2). */
import { z } from 'zod'
import { IdSchema, NameSchema, SeqSchema, TimestampSchema } from './schema-util'

export const MESSAGE_KINDS = ['chat', 'ask', 'reply', 'progress', 'system'] as const
export const MessageKindSchema = z.enum(MESSAGE_KINDS)
export type MessageKind = z.infer<typeof MessageKindSchema>

export const ASK_STATES = [
  'queued',
  'delivered',
  'working',
  'answered',
  'declined',
  'failed',
  'expired',
  'cancelled',
] as const
export const AskStateSchema = z.enum(ASK_STATES)
export type AskState = z.infer<typeof AskStateSchema>

export const TERMINAL_ASK_STATES: ReadonlySet<AskState> = new Set([
  'answered',
  'declined',
  'failed',
  'expired',
  'cancelled',
])
export const isTerminalAskState = (state: AskState): boolean => TERMINAL_ASK_STATES.has(state)

/** States a reply may close an ask with (`msg.reply`). */
export const REPLY_STATES = ['answered', 'declined', 'failed'] as const
export const ReplyStateSchema = z.enum(REPLY_STATES)
export type ReplyState = z.infer<typeof ReplyStateSchema>

/** §6.2 failure reasons. */
export const ASK_FAIL_REASONS = ['target_lost', 'not_in_room', 'no_reply', 'expired', 'declined'] as const
export const AskFailReasonSchema = z.enum(ASK_FAIL_REASONS)
export type AskFailReason = z.infer<typeof AskFailReasonSchema>

/** `meta.mode` on an ask: a label for the receiver, NOT a permission. */
export const AskModeSchema = z.enum(['read', 'write'])
export type AskMode = z.infer<typeof AskModeSchema>

/** Known meta fields; any other keys pass through. */
export const MessageMetaSchema = z.looseObject({
  mode: AskModeSchema.optional(),
  /** §7.3: the reply was sent by the fallback, not by `peers_reply`. */
  auto: z.boolean().optional(),
})
export type MessageMeta = z.infer<typeof MessageMetaSchema>

export const MessageSenderSchema = z.object({
  handle: NameSchema,
  member: NameSchema,
  session_id: IdSchema.optional(),
})
export type MessageSender = z.infer<typeof MessageSenderSchema>

/** The ask summary carried on `kind: ask` messages (and on replies, with the closing state). */
export const MessageAskSchema = z.object({
  state: AskStateSchema,
  expires_at: TimestampSchema.optional(),
  reason: AskFailReasonSchema.optional(),
})

/** §6.1 message object. `from` is absent on `system` messages. */
export const MessageSchema = z.object({
  id: IdSchema,
  client_msg_id: z.string().max(128).nullish(),
  room_id: IdSchema,
  seq: SeqSchema,
  from: MessageSenderSchema.nullish(),
  kind: MessageKindSchema,
  to: z.array(NameSchema).default([]),
  text: z.string(),
  /** reply/progress: the ask_id. */
  re: IdSchema.nullish(),
  meta: MessageMetaSchema.nullish(),
  ask: MessageAskSchema.nullish(),
  ts: TimestampSchema,
})
export type Message = z.infer<typeof MessageSchema>

/** §6.2 ask record. */
export const AskRecordSchema = z.object({
  ask_id: IdSchema,
  room_id: IdSchema,
  from_handle: NameSchema,
  from_member: NameSchema,
  to_handle: NameSchema,
  state: AskStateSchema,
  assignee_session: IdSchema.nullish(),
  expires_at: TimestampSchema,
  reason: AskFailReasonSchema.optional(),
})
export type AskRecord = z.infer<typeof AskRecordSchema>
