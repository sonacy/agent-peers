/** Member SSE events (`GET /v0/me/events`), validated with the protocol schemas (DASHBOARD §11). */
import { isMemberEventName, MEMBER_EVENTS, type MemberEventName } from '@agent-peers/protocol'
import type { Parsed } from '../api/types'

export type MemberEventData<E extends MemberEventName> = Parsed<(typeof MEMBER_EVENTS)[E]>

export type MemberEvent = {
  [E in MemberEventName]: { readonly name: E; readonly data: MemberEventData<E> }
}[MemberEventName]

export const MEMBER_EVENT_NAMES = Object.keys(MEMBER_EVENTS) as readonly MemberEventName[]

/** Parses one frame; undefined for unknown names or payloads that don't match (ignored, §11). */
export function parseEvent(name: string, raw: string): MemberEvent | undefined {
  if (!isMemberEventName(name)) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = MEMBER_EVENTS[name].safeParse(value)
  return parsed.success ? ({ name, data: parsed.data } as MemberEvent) : undefined
}
