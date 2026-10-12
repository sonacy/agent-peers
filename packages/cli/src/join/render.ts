/**
 * Shell output of hub data. Roster lines carry no free text except the sanitized model; peer
 * message text only ever appears inside the PROTOCOL §7.2 nonce envelope.
 */
import {
  buildEnvelope,
  type DeepReadonly,
  type MemberEntry,
  type Message,
  sanitizeLine,
} from '@agent-peers/protocol'

/** `@work · claude-code · claude-opus-5-5 · online · idle · push` */
export function memberLine(member: DeepReadonly<MemberEntry>, self: string | undefined): string {
  const card = member.card
  const model = card.model ? sanitizeLine(card.model, 40) : 'model ?'
  const dnd = card.accepting ? '' : ' · dnd'
  const you = member.handle === self ? ' (you)' : ''
  return `@${member.handle} · ${card.agent.kind} · ${model} · ${card.connection} · ${card.activity} · ${card.inject}${dnd}${you}`
}

/** Shell output has no injection budget: messages keep their full text (64 KiB at most). */
const SHELL_MAX_CHARS = 80_000

export function messageEnvelope(message: DeepReadonly<Message>, roomName: string, askText?: string): string {
  return buildEnvelope({
    message,
    roomName,
    maxChars: SHELL_MAX_CHARS,
    ...(askText ? { askText } : {}),
  }).text
}

/** Parses `@handle` or `@handle@room`. */
export function parseTarget(raw: string): { readonly handle: string; readonly room?: string } | undefined {
  const match = /^@?([a-z0-9][a-z0-9_-]{0,31})(?:@([a-z0-9][a-z0-9_-]{0,31}))?$/.exec(raw.trim())
  if (!match?.[1]) return undefined
  return match[2] ? { handle: match[1], room: match[2] } : { handle: match[1] }
}
