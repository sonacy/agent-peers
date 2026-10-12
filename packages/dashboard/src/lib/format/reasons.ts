/** Ask failure reasons in plain words (DASHBOARD §8). */
import type { AskFailReason } from '@agent-peers/protocol'

const REASON_TEXT: Readonly<Record<Exclude<AskFailReason, 'declined'>, string>> = {
  not_in_room: '你们俩已经不在同一个房间了',
  target_lost: '对方断开了，没答完',
  expired: '一天没人答，过期了',
  no_reply: '对方结束了这一轮，但没回答',
}

export const UNKNOWN_REASON_TEXT = '原因不明，稍后再问一次'

/** `declined` shows the agent's own text; unknown or missing reasons get a generic next step. */
export function failReasonText(reason: AskFailReason | undefined, declinedText?: string): string {
  if (reason === 'declined') {
    const text = declinedText?.trim()
    return text === undefined || text === '' ? '对方没有说原因' : text
  }
  return reason === undefined ? UNKNOWN_REASON_TEXT : REASON_TEXT[reason]
}
