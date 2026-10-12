/**
 * 房间里的人 (DASHBOARD §4.3): status filters, 只看我的, search, big-room collapsing and paging.
 * Pure functions over the room detail's people-grouped-by-member list.
 */
import type { RoomAgent, RoomDetail, RoomPerson } from '../../../api/types'
import { agentKindLabel, agentStatus } from '../../../lib/agent'

/** Rooms with more people than this collapse their groups, filter and page (§4.3 big rooms). */
export const BIG_ROOM_PEOPLE = 10
export const PEOPLE_PAGE = 20
/** A collapsed group shows at most this many chips, then 再看 N 个. */
export const CHIP_LIMIT = 6

export const PEOPLE_FILTERS = ['all', 'idle', 'busy', 'offline'] as const
export type PeopleFilter = (typeof PEOPLE_FILTERS)[number]

export const PEOPLE_FILTER_LABEL: Readonly<Record<PeopleFilter, string>> = {
  all: '全部',
  idle: '有空',
  busy: '正在忙',
  offline: '离线',
}

export interface PeopleQuery {
  readonly filter: PeopleFilter
  readonly mineOnly: boolean
  readonly search: string
}

export const NO_QUERY: PeopleQuery = { filter: 'all', mineOnly: false, search: '' }

/** `awaiting` (等你确认) counts as busy, like the home filters. */
export function agentFilterOf(agent: RoomAgent): Exclude<PeopleFilter, 'all'> {
  const status = agentStatus(agent.card)
  return status === 'awaiting' ? 'busy' : status
}

export function isBigRoom(detail: RoomDetail): boolean {
  return detail.people.length > BIG_ROOM_PEOPLE
}

export function agentCount(people: readonly RoomPerson[]): number {
  return people.reduce((sum, person) => sum + person.agents.length, 0)
}

export function idleCount(agents: readonly RoomAgent[]): number {
  return agents.filter((a) => agentFilterOf(a) === 'idle').length
}

/** Counts for the filter chips: agents per status across the room. */
export function filterCounts(people: readonly RoomPerson[]): Readonly<Record<PeopleFilter, number>> {
  const agents = people.flatMap((p) => p.agents)
  const count = (key: Exclude<PeopleFilter, 'all'>) => agents.filter((a) => agentFilterOf(a) === key).length
  return { all: agents.length, idle: count('idle'), busy: count('busy'), offline: count('offline') }
}

function matchesText(person: RoomPerson, agent: RoomAgent | undefined, q: string): boolean {
  if (person.member.toLowerCase().includes(q)) return true
  if (agent === undefined) return false
  return [agent.card.title ?? '', agent.handle].some((text) => text.toLowerCase().includes(q))
}

/**
 * The people to show and, for each, the agents that match. With no status filter or search a person
 * with no agents still shows (`还没有 agent 进来`); otherwise people with no matching agent drop out,
 * unless the search matched their own name.
 */
export function applyPeopleQuery(people: readonly RoomPerson[], query: PeopleQuery): readonly RoomPerson[] {
  const q = query.search.trim().toLowerCase()
  const narrowing = query.filter !== 'all' || q !== ''
  return people
    .filter((person) => !query.mineOnly || person.is_me)
    .flatMap((person) => {
      const nameHit = q !== '' && person.member.toLowerCase().includes(q)
      const agents = person.agents.filter(
        (agent) =>
          (query.filter === 'all' || agentFilterOf(agent) === query.filter) &&
          (q === '' || nameHit || matchesText(person, agent, q)),
      )
      if (narrowing && agents.length === 0 && !(nameHit && query.filter === 'all')) return []
      return [{ ...person, agents }]
    })
}

export function canRemoveAgent(detail: RoomDetail, person: RoomPerson): boolean {
  return person.is_me || detail.my_role === 'owner'
}

export function canManagePerson(detail: RoomDetail, person: RoomPerson): boolean {
  return detail.my_role === 'owner' && !person.is_me && person.role !== 'owner'
}

export const ROLE_LABEL: Readonly<Record<RoomPerson['role'], string>> = {
  owner: '房主',
  member: '成员',
  readonly: '只读',
}

export function ownerName(detail: RoomDetail): string {
  return detail.room.owner ?? detail.people.find((p) => p.role === 'owner')?.member ?? '房主'
}

/** The session title, or `{tool} · {host}` for untitled sessions (as on 我的 agent). */
export function agentTitle(agent: RoomAgent): string {
  const title = agent.card.title?.trim()
  return title === undefined || title === ''
    ? `${agentKindLabel(agent.card.agent.kind)} · ${agent.card.host}`
    : title
}
