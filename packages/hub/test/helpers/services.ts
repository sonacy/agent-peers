/** In-memory service harness: ':memory:' SQLite, a fake clock and a recording session link. */
import type { CardInput, NotificationName } from '@agent-peers/protocol'
import { CardInputSchema } from '@agent-peers/protocol'
import { type HubConfigInput, resolveConfig, silentLogger } from '../../src/config'
import type { Actor } from '../../src/services/access'
import { createDeps, createLinkPort, type SessionLink } from '../../src/services/context'
import { createEventBus, type HubEvent } from '../../src/services/events'
import { createServices, type Services } from '../../src/services/index'
import { openDatabase } from '../../src/storage/db'
import { createRepos } from '../../src/storage/repos'
import { FakeClock } from './fake-clock'

export interface Note {
  readonly sessionId: string
  readonly name: NotificationName
  readonly params: Record<string, unknown>
}

export class RecordingLink implements SessionLink {
  notes: Note[] = []
  detached: string[] = []
  attached = new Set<string>()

  notify(sessionId: string, name: NotificationName, params: unknown): void {
    this.notes.push({ sessionId, name, params: params as Record<string, unknown> })
  }
  lastSeen(sessionId: string): number | undefined {
    return this.attached.has(sessionId) ? 1 : undefined
  }
  detach(sessionId: string): void {
    this.detached.push(sessionId)
  }
  disconnected: string[] = []
  disconnectMember(memberId: string): readonly string[] {
    this.disconnected.push(memberId)
    return []
  }
  of(sessionId: string, name?: NotificationName): Note[] {
    return this.notes.filter((n) => n.sessionId === sessionId && (name === undefined || n.name === name))
  }
  clear(): void {
    this.notes = []
  }
}

export interface Harness {
  readonly clock: FakeClock
  readonly services: Services
  readonly link: RecordingLink
  readonly events: HubEvent[]
  member(name: string): { id: string; token: string }
  open(
    memberId: string,
    localKey: string,
    card?: Partial<CardInput>,
    extra?: { supersedes?: string; outdated?: boolean },
  ): string
  room(ownerId: string, name: string, discoverable?: boolean): string
  grant(roomId: string, memberId: string, role?: 'member' | 'readonly'): void
  join(sessionId: string, roomId: string, handle?: string, takeover?: boolean): string
  as(memberId: string, sessionId?: string): Actor
}

export function makeHarness(overrides: HubConfigInput = {}): Harness {
  const clock = new FakeClock()
  const config = resolveConfig({ logger: silentLogger, clock, ...overrides })
  const db = openDatabase(':memory:')
  const port = createLinkPort()
  const link = new RecordingLink()
  port.bind(link)
  const events = createEventBus(silentLogger)
  const runtime = { publicUrl: 'http://127.0.0.1:7337' as string | undefined, inviteSecret: 'test-secret' }
  const deps = createDeps({ db, repos: createRepos(db), config, events, runtime, link: port })
  const services = createServices(deps)
  const recorded: HubEvent[] = []
  events.on((e) => recorded.push(e))

  const h: Harness = {
    clock,
    services,
    link,
    events: recorded,
    member(name) {
      const issued = services.members.create(name)
      return { id: issued.member.id, token: issued.token }
    },
    open(memberId, localKey, card = {}, extra = {}) {
      const parsed = CardInputSchema.parse({
        agent: { kind: 'claude-code', adapter: '0.3.0' },
        host: 'laptop',
        ...card,
      })
      const result = services.sessions.open(
        { memberId, outdated: extra.outdated ?? false },
        { local_key: localKey, card: parsed, ...(extra.supersedes ? { supersedes: extra.supersedes } : {}) },
      )
      link.attached.add(result.session_id)
      return result.session_id
    },
    room(ownerId, name, discoverable = true) {
      return services.rooms.create({ kind: 'member', memberId: ownerId }, { name, discoverable }).room_id
    },
    grant(roomId, memberId, role = 'member') {
      services.deps.repos.grants.upsert(roomId, memberId, role, clock.now())
    },
    join(sessionId, roomId, handle, takeover) {
      return services.rooms.join(sessionId, {
        session_id: sessionId,
        room_id: roomId,
        ...(handle !== undefined ? { handle } : {}),
        ...(takeover !== undefined ? { takeover } : {}),
      } as never).handle
    },
    as(memberId, sessionId) {
      return sessionId ? { kind: 'session', memberId, sessionId } : { kind: 'member', memberId }
    },
  }
  return h
}

export const cmid = (() => {
  let n = 0
  return () => `cmid-${++n}`
})()
