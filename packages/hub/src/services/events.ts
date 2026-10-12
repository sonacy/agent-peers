/**
 * EventBus: typed hub events for the member/admin dashboards (DASHBOARD §11). The HTTP layer turns
 * them into SSE frames with `encodeMemberEvent`, filtering by `memberIds`.
 */
import type { MEMBER_EVENTS, MemberEventName } from '@agent-peers/protocol'
import type { z } from 'zod'
import type { Logger } from '../config'

export type HubEventData<E extends MemberEventName> = z.input<(typeof MEMBER_EVENTS)[E]>

export type HubEvent = {
  readonly [E in MemberEventName]: {
    readonly name: E
    readonly data: HubEventData<E>
    /** Members allowed to see the event. The operator (admin) view sees every event. */
    readonly memberIds: readonly string[]
    readonly roomId?: string
  }
}[MemberEventName]

export type HubEventListener = (event: HubEvent) => void

export interface EventBus {
  emit(event: HubEvent): void
  on(listener: HubEventListener): () => void
  /** Events visible to one member. */
  onMember(memberId: string, listener: HubEventListener): () => void
  readonly listenerCount: number
}

export function createEventBus(logger: Logger): EventBus {
  let listeners: readonly HubEventListener[] = []
  const on = (listener: HubEventListener) => {
    listeners = [...listeners, listener]
    return () => {
      listeners = listeners.filter((l) => l !== listener)
    }
  }
  return {
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          logger.error(`event listener failed for ${event.name}`, error)
        }
      }
    },
    on,
    onMember(memberId, listener) {
      return on((event) => {
        if (event.memberIds.includes(memberId)) listener(event)
      })
    },
    get listenerCount() {
      return listeners.length
    },
  }
}
