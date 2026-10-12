/**
 * 房间里的人 (DASHBOARD §4.3): the /peers:join helper, big-room filters, the MemberGroup list, and
 * the owner's actions (⇥ 移出房间, 请出房间, and on phones the person sheet).
 */
import { useState } from 'react'
import type { RoomDetail, RoomPerson } from '../../../api/types'
import { PHONE_QUERY, useMediaQuery } from '../../../lib/hooks/use-media-query'
import { NoAgentsEmpty } from '../../empty-state'
import { InlineCode } from '../../ui/input'
import { useKickPerson, useRemoveAgent, useRemoveAllAgents } from '../data/use-room-actions'
import { ConfirmDialog } from '../detail/confirm-dialogs'
import {
  agentCount,
  applyPeopleQuery,
  canManagePerson,
  canRemoveAgent,
  isBigRoom,
  NO_QUERY,
  PEOPLE_PAGE,
  type PeopleQuery,
} from '../model/people-model'
import type { GroupActions } from './member-group'
import { PeopleFilters } from './people-filters'
import { PeopleList } from './people-list'
import { PersonSheet } from './person-sheet'

export function joinCommand(roomName: string): string {
  return `/peers:join ${roomName}`
}

function usePeopleActions(
  detail: RoomDetail,
  phone: boolean,
  handlers: { readonly onManage: (p: RoomPerson) => void; readonly onKick: (p: RoomPerson) => void },
): GroupActions {
  const removeAgent = useRemoveAgent(detail.room.room_id)
  return {
    canRemove: (person) => canRemoveAgent(detail, person),
    canManage: (person) => canManagePerson(detail, person),
    onRemoveAgent: (agent) => removeAgent.mutate(agent.card.session_id),
    onKick: handlers.onKick,
    ...(phone ? { onManage: handlers.onManage } : {}),
  }
}

/** What 请出房间 does, said before it happens: the invite is rotated too (PROTOCOL §9). */
export function kickDescription(name: string): string {
  return `${name} 和他的 agent 会离开房间，之后不能再用邀请码进来。为了这一点邀请码也会换新，之前发出去的邀请都失效。`
}

/** 请出房间 always asks first, from the inline button, the big-room ⋯ menu and the phone sheet. */
function KickConfirm({
  roomId,
  person,
  onClose,
}: {
  readonly roomId: string
  readonly person: RoomPerson | undefined
  readonly onClose: () => void
}) {
  const kick = useKickPerson(roomId)
  return (
    <ConfirmDialog
      open={person !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onConfirm={() => {
        if (person !== undefined) kick.mutate({ memberId: person.member_id, name: person.member })
      }}
      title={`请 ${person?.member ?? ''} 出房间`}
      description={kickDescription(person?.member ?? '')}
      confirmLabel="请出房间"
      tone="danger"
    />
  )
}

function Helper({ roomName }: { readonly roomName: string }) {
  return (
    <p className="text-meta text-muted">
      把自己的另一个对话拉进来：在那个对话里说{' '}
      <InlineCode className="whitespace-nowrap">{joinCommand(roomName)}</InlineCode>
    </p>
  )
}

export function PeopleSection({ detail }: { readonly detail: RoomDetail }) {
  const phone = useMediaQuery(PHONE_QUERY)
  const big = isBigRoom(detail)
  const [query, setQuery] = useState<PeopleQuery>(NO_QUERY)
  const [limit, setLimit] = useState(PEOPLE_PAGE)
  const [managing, setManaging] = useState<RoomPerson | undefined>(undefined)
  const [kicking, setKicking] = useState<RoomPerson | undefined>(undefined)
  const actions = usePeopleActions(detail, phone, { onManage: setManaging, onKick: setKicking })
  const removeAll = useRemoveAllAgents(detail.room.room_id)
  const matching = applyPeopleQuery(detail.people, query)
  const narrowing = query !== NO_QUERY
  const shown = big ? matching.slice(0, limit) : matching
  const changeQuery = (next: PeopleQuery) => {
    setQuery(next.filter === 'all' && !next.mineOnly && next.search === '' ? NO_QUERY : next)
    setLimit(PEOPLE_PAGE)
  }
  return (
    <section aria-labelledby="people-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h2 id="people-title" className="font-display font-bold text-section">
          房间里的人
        </h2>
        <Helper roomName={detail.room.name} />
      </div>
      {big ? <PeopleFilters people={detail.people} query={query} onChange={changeQuery} /> : null}
      {agentCount(detail.people) === 0 && !narrowing ? <NoAgentsEmpty /> : null}
      {matching.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-muted/40 px-4 py-6 text-center text-muted text-sm">
          没有符合的人或 agent。换个筛选，或者清空搜索看看。
        </p>
      ) : (
        <PeopleList
          people={shown}
          total={matching.length}
          actions={actions}
          big={big}
          narrowing={narrowing}
          onMore={() => setLimit((n) => n + PEOPLE_PAGE)}
        />
      )}
      <PersonSheet
        person={managing}
        onClose={() => setManaging(undefined)}
        onRemoveAll={(p) =>
          removeAll.mutate({
            memberId: p.member_id,
            name: p.member,
            sessionIds: p.agents.map((a) => a.card.session_id),
          })
        }
        onKick={setKicking}
      />
      <KickConfirm roomId={detail.room.room_id} person={kicking} onClose={() => setKicking(undefined)} />
    </section>
  )
}
