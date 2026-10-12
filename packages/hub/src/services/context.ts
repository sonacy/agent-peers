/**
 * Shared service dependencies. Every mutation runs in `tx`: one SQLite transaction whose
 * notifications, events and follow-ups are flushed only after it commits.
 */
import type { Database } from 'bun:sqlite'
import { createUlidFactory, type NotificationInputOf, type NotificationName } from '@agent-peers/protocol'
import type { Clock } from '../clock'
import type { HubConfig } from '../config'
import type { Repos } from '../storage/repos'
import type { EventBus, HubEvent } from './events'

export type NotifyParams<N extends NotificationName> = Omit<NotificationInputOf<N>, 'session_id'>

/** The WS layer's view of live sessions, bound at start. */
export interface SessionLink {
  /** Sends a notification to the session's current connection; dropped when it has none. */
  notify<N extends NotificationName>(sessionId: string, name: N, params: NotifyParams<N>): void
  /** Last frame time on the session's connection, when attached. */
  lastSeen(sessionId: string): number | undefined
  /** Detaches a session from its connection (supersede / fencing). */
  detach(sessionId: string): void
  /** Closes every live connection of a member; returns the sessions that were attached to them. */
  disconnectMember(memberId: string): readonly string[]
}

export interface Effects {
  notify<N extends NotificationName>(sessionId: string, name: N, params: NotifyParams<N>): void
  emit(event: HubEvent): void
  /** Runs after commit, after notifications and events. */
  after(fn: () => void): void
}

export interface Runtime {
  /** The base for invite and login URLs; undefined until the public listener is bound. */
  publicUrl: string | undefined
  inviteSecret: string
}

export interface ServiceDeps {
  readonly db: Database
  readonly repos: Repos
  readonly config: HubConfig
  readonly clock: Clock
  readonly events: EventBus
  readonly link: LinkPort
  readonly runtime: Runtime
  newId(): string
  now(): number
  tx<T>(fn: (fx: Effects) => T): T
}

export interface LinkPort extends SessionLink {
  bind(link: SessionLink | undefined): void
}

export function createLinkPort(): LinkPort {
  let bound: SessionLink | undefined
  return {
    bind(link) {
      bound = link
    },
    notify(sessionId, name, params) {
      bound?.notify(sessionId, name, params)
    },
    lastSeen(sessionId) {
      return bound?.lastSeen(sessionId)
    },
    detach(sessionId) {
      bound?.detach(sessionId)
    },
    disconnectMember(memberId) {
      return bound?.disconnectMember(memberId) ?? []
    },
  }
}

type Notification = { readonly sessionId: string; readonly name: NotificationName; readonly params: unknown }

interface Collector {
  readonly fx: Effects
  readonly notifications: Notification[]
  readonly events: HubEvent[]
  readonly afters: (() => void)[]
}

function createCollector(): Collector {
  const notifications: Notification[] = []
  const events: HubEvent[] = []
  const afters: (() => void)[] = []
  const fx: Effects = {
    notify: (sessionId, name, params) => notifications.push({ sessionId, name, params }),
    emit: (event) => events.push(event),
    after: (fn) => afters.push(fn),
  }
  return { fx, notifications, events, afters }
}

export interface DepsInput {
  readonly db: Database
  readonly repos: Repos
  readonly config: HubConfig
  readonly events: EventBus
  readonly runtime: Runtime
  readonly link?: LinkPort
}

export function createDeps(input: DepsInput): ServiceDeps {
  const { db, config, events } = input
  const link = input.link ?? createLinkPort()
  const clock = config.clock
  const ulid = createUlidFactory()
  let current: Collector | undefined

  const flush = (collector: Collector) => {
    for (const n of collector.notifications) {
      link.notify(n.sessionId, n.name, n.params as NotifyParams<typeof n.name>)
    }
    for (const event of collector.events) events.emit(event)
    for (const fn of collector.afters) fn()
  }

  const tx = <T>(fn: (fx: Effects) => T): T => {
    if (current) return fn(current.fx)
    const collector = createCollector()
    current = collector
    let result: T
    try {
      result = db.transaction(() => fn(collector.fx))()
    } finally {
      current = undefined
    }
    flush(collector)
    return result
  }

  return {
    db,
    repos: input.repos,
    config,
    clock,
    events,
    link,
    runtime: input.runtime,
    newId: config.newId ?? (() => ulid(clock.now())),
    now: () => clock.now(),
    tx,
  }
}
