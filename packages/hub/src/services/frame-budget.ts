/**
 * Outbound frame budget (§1: frames ≤ 256 KiB). Results that list messages are cut to fit one frame,
 * newest kept, so a valid request never fails with `payload_too_large`; the caller pages on.
 */
import {
  FRAME_ENVELOPE_MARGIN_BYTES,
  MAX_FRAME_BYTES,
  type Message,
  utf8ByteLength,
} from '@agent-peers/protocol'

/** Bytes a payload may use inside one frame, leaving room for the JSON-RPC envelope around it. */
export const FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - FRAME_ENVELOPE_MARGIN_BYTES

export const encodedSize = (value: unknown): number => utf8ByteLength(JSON.stringify(value) ?? '')

export interface FittedPage {
  readonly messages: readonly Message[]
  /** True when older messages were left out to fit the frame. */
  readonly truncated: boolean
}

/**
 * Keeps the newest messages (input is oldest first) whose encoded size fits `budget`, in the same
 * order. The newest message is always kept, so paging always makes progress.
 */
export function fitNewest(messages: readonly Message[], budget: number = FRAME_BUDGET_BYTES): FittedPage {
  let used = 0
  let start = messages.length
  while (start > 0) {
    const size = encodedSize(messages[start - 1]) + 1
    if (used + size > budget && start < messages.length) break
    used += size
    start -= 1
  }
  return { messages: messages.slice(start), truncated: start > 0 }
}
