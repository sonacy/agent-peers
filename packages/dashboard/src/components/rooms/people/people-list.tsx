/**
 * The MemberGroup list. Small rooms render every group open. Big rooms page 20 people at a time
 * (`已显示 20 / 128 人` + 加载更多) through a window virtualizer, so 200 groups never mount at once.
 */
import { measureElement, useWindowVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type { RoomPerson } from '../../../api/types'
import { Button } from '../../ui/button'
import { type GroupActions, MemberGroup } from './member-group'

/**
 * Height of a collapsed group card (78px, measured) plus its 12px gap. Real heights are measured
 * (`measureElement` + `data-index`), so expanded groups resize; a close estimate keeps the total
 * height honest and scrolling steady.
 */
const ESTIMATE_PX = 90
/** A whole page (PEOPLE_PAGE) stays mounted around the viewport, so full-page captures aren't blank. */
const OVERSCAN = 20

export interface PeopleListProps {
  readonly people: readonly RoomPerson[]
  readonly total: number
  readonly actions: GroupActions
  readonly big: boolean
  /** Filters or search are on: open every group so matching agents show. */
  readonly narrowing: boolean
  readonly onMore: () => void
}

function toggle(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function useGroupState(people: readonly RoomPerson[]) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(people.filter((p) => p.is_me).map((p) => p.member_id)),
  )
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set())
  return {
    expanded,
    showAll,
    toggle: (id: string) => setExpanded((set) => toggle(set, id)),
    reveal: (id: string) => setShowAll((set) => new Set([...set, id])),
  }
}

function VirtualGroups({
  people,
  render,
}: {
  readonly people: readonly RoomPerson[]
  readonly render: (person: RoomPerson) => ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const node = listRef.current
    if (node !== null) setMargin(node.getBoundingClientRect().top + window.scrollY)
  }, [])
  const virtualizer = useWindowVirtualizer({
    count: people.length,
    estimateSize: () => ESTIMATE_PX,
    overscan: OVERSCAN,
    scrollMargin: margin,
    getItemKey: (index) => people[index]?.member_id ?? index,
    // A group with no box yet (detached, or a layout-less renderer) keeps its estimate.
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance)
      return size > 0 ? size : ESTIMATE_PX
    },
  })
  return (
    <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const person = people[item.index]
        if (person === undefined) return null
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full pb-3"
            style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
          >
            {render(person)}
          </div>
        )
      })}
    </div>
  )
}

export function PeopleList({ people, total, actions, big, narrowing, onMore }: PeopleListProps) {
  const state = useGroupState(people)
  const render = (person: RoomPerson) => (
    <MemberGroup
      person={person}
      actions={actions}
      big={big}
      expanded={!big || narrowing || state.expanded.has(person.member_id)}
      showAll={!big || state.showAll.has(person.member_id)}
      onToggle={() => state.toggle(person.member_id)}
      onShowAll={() => state.reveal(person.member_id)}
    />
  )
  if (!big) {
    return (
      <div className="flex flex-col gap-3">
        {people.map((person) => (
          <div key={person.member_id}>{render(person)}</div>
        ))}
      </div>
    )
  }
  return (
    <>
      <VirtualGroups people={people} render={render} />
      <div className="flex items-center justify-center gap-3 text-meta text-muted">
        <span aria-live="polite">
          已显示 {people.length} / {total} 人
        </span>
        {people.length < total ? (
          <Button size="sm" onClick={onMore}>
            加载更多
          </Button>
        ) : null}
      </div>
    </>
  )
}
