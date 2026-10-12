/** 我的 agent (DASHBOARD §4.1): filter chips and the responsive AgentCard grid with its states. */
import { useMemo, useState } from 'react'
import { friendlyError } from '../../api/errors'
import { useMyRooms, useSessions } from '../../api/queries'
import { NoAgentsEmpty } from '../../components/empty-state'
import { ErrorBanner } from '../../components/error-banner'
import { SectionHeader } from '../../components/page-header'
import { FilterChip } from '../../components/ui/chip'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { allowWobble } from '../../lib/motion'
import { useMotionPreference } from '../../lib/motion-preference'
import { AgentCard } from './agent-card'
import { AGENT_FILTERS, type AgentFilter, FILTER_LABEL, filterCounts, matchesFilter } from './agent-filters'

export const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

/** room_id → display name, from my rooms; falls back to a neutral label until rooms load. */
export function useRoomNames(): (roomId: string) => string {
  const rooms = useMyRooms()
  return useMemo(() => {
    const names = new Map((rooms.data ?? []).map((r) => [r.room.room_id, r.room.display_name ?? r.room.name]))
    return (roomId: string) => names.get(roomId) ?? '房间'
  }, [rooms.data])
}

function GridSkeleton() {
  return (
    <div className={GRID}>
      {['a', 'b', 'c', 'd'].map((key) => (
        <CardSkeleton key={key} className="h-40 items-start" />
      ))}
    </div>
  )
}

function FilterRow({
  filter,
  counts,
  onChange,
}: {
  readonly filter: AgentFilter
  readonly counts: Readonly<Record<AgentFilter, number>>
  readonly onChange: (filter: AgentFilter) => void
}) {
  return (
    <fieldset className="scrollbar-none -mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 py-1.5 sm:mx-0 sm:px-0">
      <legend className="sr-only">按状态筛选</legend>
      {AGENT_FILTERS.map((key) => (
        <FilterChip key={key} selected={filter === key} onClick={() => onChange(key)}>
          {FILTER_LABEL[key]} {counts[key]}
        </FilterChip>
      ))}
    </fieldset>
  )
}

export function AgentsSection() {
  const sessions = useSessions()
  const roomName = useRoomNames()
  const { reduced } = useMotionPreference()
  const [filter, setFilter] = useState<AgentFilter>('all')
  const cards = sessions.data ?? []
  const counts = filterCounts(cards)
  const shown = cards.filter((card) => matchesFilter(card, filter))
  const wobble = allowWobble(shown.length, reduced)
  return (
    <section aria-labelledby="agents-title" className="flex flex-col gap-4">
      <SectionHeader title="我的 agent" id="agents-title">
        {cards.length > 0 ? <FilterRow filter={filter} counts={counts} onChange={setFilter} /> : null}
      </SectionHeader>
      {sessions.isError && sessions.data === undefined ? (
        <ErrorBanner
          title="没拿到你的 agent 列表"
          description={friendlyError(sessions.error)}
          actionLabel="重试"
          onAction={() => void sessions.refetch()}
        />
      ) : null}
      <DelayedSkeleton loading={sessions.isPending} fallback={<GridSkeleton />} label="正在加载 agent…">
        {sessions.isSuccess && cards.length === 0 ? <NoAgentsEmpty /> : null}
        {cards.length > 0 && shown.length === 0 ? (
          <p className="rounded-2xl border-2 border-muted/40 border-dashed px-4 py-6 text-center text-muted text-sm">
            没有{FILTER_LABEL[filter]}的 agent。换个筛选看看。
          </p>
        ) : null}
        {shown.length > 0 ? (
          <ul className={GRID}>
            {shown.map((card, index) => (
              <AgentCard
                key={card.session_id}
                card={card}
                roomName={roomName}
                index={index}
                wobble={wobble}
              />
            ))}
          </ul>
        ) : null}
      </DelayedSkeleton>
    </section>
  )
}
