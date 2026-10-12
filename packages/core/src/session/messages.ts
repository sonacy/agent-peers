/** Builders for the idempotent send methods: auto `client_msg_id`, text-size check (PROTOCOL §1). */
import {
  MAX_TEXT_BYTES,
  type MsgReplyParams,
  type MsgSendParams,
  type ParamsOf,
  PeersError,
  utf8ByteLength,
} from '@agent-peers/protocol'

export interface ChatInput {
  readonly room_id: string
  readonly text: string
  readonly to?: readonly string[]
  readonly meta?: Readonly<Record<string, unknown>>
  readonly client_msg_id?: string
}

export interface AskInput {
  readonly room_id: string
  /** Target handle (exactly one, §6.1). */
  readonly to: string
  readonly text: string
  /** A label for the receiver, NOT a permission (§6.1). Default `read`. */
  readonly mode?: 'read' | 'write'
  readonly meta?: Readonly<Record<string, unknown>>
  readonly ttl_ms?: number
  readonly require_online?: boolean
  readonly client_msg_id?: string
}

export interface ReplyInput {
  readonly ask_id: string
  readonly text: string
  readonly state?: 'answered' | 'declined' | 'failed'
  readonly meta?: Readonly<Record<string, unknown>>
  readonly client_msg_id?: string
}

export interface ProgressInput {
  readonly ask_id: string
  readonly text: string
  readonly client_msg_id?: string
}

export function assertTextSize(text: string): void {
  const size = utf8ByteLength(text)
  if (size > MAX_TEXT_BYTES) {
    throw new PeersError('payload_too_large', `message text is ${size} bytes; the limit is ${MAX_TEXT_BYTES}`)
  }
}

function optional<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

export function chatParams(sessionId: string, input: ChatInput, newId: () => string): MsgSendParams {
  assertTextSize(input.text)
  return {
    session_id: sessionId,
    client_msg_id: input.client_msg_id ?? newId(),
    room_id: input.room_id,
    kind: 'chat',
    text: input.text,
    ...optional({ to: input.to, meta: input.meta }),
  }
}

export function askParams(sessionId: string, input: AskInput, newId: () => string): MsgSendParams {
  assertTextSize(input.text)
  return {
    session_id: sessionId,
    client_msg_id: input.client_msg_id ?? newId(),
    room_id: input.room_id,
    kind: 'ask',
    to: [input.to],
    text: input.text,
    meta: { ...input.meta, mode: input.mode ?? 'read' },
    ...optional({ ttl_ms: input.ttl_ms, require_online: input.require_online }),
  }
}

export function replyParams(sessionId: string, input: ReplyInput, newId: () => string): MsgReplyParams {
  assertTextSize(input.text)
  return {
    session_id: sessionId,
    client_msg_id: input.client_msg_id ?? newId(),
    ask_id: input.ask_id,
    text: input.text,
    state: input.state ?? 'answered',
    ...optional({ meta: input.meta }),
  }
}

export function progressParams(
  sessionId: string,
  input: ProgressInput,
  newId: () => string,
): ParamsOf<'msg.progress'> {
  assertTextSize(input.text)
  return {
    session_id: sessionId,
    client_msg_id: input.client_msg_id ?? newId(),
    ask_id: input.ask_id,
    text: input.text,
  }
}
