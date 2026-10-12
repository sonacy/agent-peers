/** Session cards (§3): bridge-supplied fields stored as JSON, hub-owned fields from the session row. */
import {
  type Activity,
  type AgentInfo,
  type CardInputSchema,
  type InjectTier,
  PeersError,
  type SessionCard,
  type Workspace,
} from '@agent-peers/protocol'
import type { z } from 'zod'
import type { SessionRow } from '../storage/repos/sessions'
import type { ServiceDeps } from './context'

/** The bridge-owned part of the card, as parsed from `session.open` and patched by `session.update`. */
export interface StoredCard {
  readonly agent: AgentInfo
  readonly host: string
  readonly model?: string
  readonly workspace?: Workspace
  readonly title?: string
  readonly summary?: string
  readonly inject?: InjectTier
  readonly activity?: Activity
  readonly accepting?: boolean
}

export type ParsedCardInput = z.output<typeof CardInputSchema>

/** Drops undefined fields so stored JSON stays minimal. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function storedCardFrom(input: ParsedCardInput): StoredCard {
  return compact({ ...input })
}

export function mergeCard(card: StoredCard, patch: Partial<StoredCard>): StoredCard {
  return compact({ ...card, ...patch })
}

export function parseStoredCard(json: string): StoredCard {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null) throw new PeersError('internal', 'corrupt session card')
  return value as StoredCard
}

export function serializeCard(card: StoredCard): string {
  return JSON.stringify(card)
}

export function isAccepting(row: SessionRow): boolean {
  return parseStoredCard(row.card_json).accepting !== false
}

export function createCards(deps: ServiceDeps) {
  const { repos } = deps

  const build = (row: SessionRow): SessionCard => {
    const stored = parseStoredCard(row.card_json)
    const member = repos.members.byId(row.member_id)
    const rooms = repos.handles.forSession(row.id).map((h) => ({ room_id: h.room_id, handle: h.handle }))
    const lastSeen = row.connection === 'offline' ? undefined : deps.link.lastSeen(row.id)
    return {
      session_id: row.id,
      member: member?.name ?? 'unknown',
      agent: stored.agent,
      ...(stored.model !== undefined ? { model: stored.model } : {}),
      host: stored.host,
      ...(stored.workspace !== undefined ? { workspace: stored.workspace } : {}),
      ...(stored.title !== undefined ? { title: stored.title } : {}),
      ...(stored.summary !== undefined ? { summary: stored.summary } : {}),
      inject: stored.inject ?? 'poll',
      connection: row.closed_at === null ? row.connection : 'offline',
      activity: stored.activity ?? 'unknown',
      accepting: stored.accepting !== false,
      outdated: row.outdated === 1,
      rooms,
      last_seen_at: Math.max(lastSeen ?? 0, row.last_seen_at),
      last_activity_at: row.last_activity_at,
    }
  }

  return {
    build,
    byId(sessionId: string): SessionCard | undefined {
      const row = repos.sessions.byId(sessionId)
      return row ? build(row) : undefined
    },
    forMember(memberId: string): readonly SessionCard[] {
      return repos.sessions.forMember(memberId).map(build)
    },
  }
}
export type Cards = ReturnType<typeof createCards>
