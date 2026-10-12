/** The many-rooms toolbar (DASHBOARD §4.2): filter box, group tabs, sort and the table/card toggle. */
import { LayoutGrid, List } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../../../lib/cn'
import { FilterChip } from '../../ui/chip'
import { SearchInput } from '../../ui/input'
import {
  GROUP_LABEL,
  ROOM_GROUPS,
  ROOM_SORTS,
  type RoomGroup,
  type RoomSort,
  SORT_LABEL,
} from '../model/rooms-model'

export type RoomsView = 'table' | 'grid'

export interface RoomsToolbarProps {
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly group: RoomGroup
  readonly counts: Readonly<Record<RoomGroup, number>>
  readonly onGroup: (group: RoomGroup) => void
  readonly sort: RoomSort
  readonly onSort: (sort: RoomSort) => void
  readonly view: RoomsView
  readonly onView: (view: RoomsView) => void
}

function ViewToggle({ view, onView }: Pick<RoomsToolbarProps, 'view' | 'onView'>) {
  const item = (value: RoomsView, label: string, Icon: typeof List) => (
    <button
      type="button"
      aria-pressed={view === value}
      aria-label={label}
      onClick={() => onView(value)}
      className={cn(
        'focus-ring inline-flex size-10 cursor-pointer items-center justify-center rounded-lg',
        view === value ? 'bg-active text-on-active' : 'text-muted hover:text-ink',
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  )
  return (
    <div className="inline-flex gap-0.5 rounded-xl border-2 border-line bg-surface p-0.5 shadow-btn">
      {item('table', '表格视图', List)}
      {item('grid', '卡片视图', LayoutGrid)}
    </div>
  )
}

export function RoomsToolbar(props: RoomsToolbarProps) {
  const sortId = useId()
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
      <SearchInput
        label="在我的房间里找"
        value={props.query}
        onValueChange={props.onQuery}
        placeholder="房间名或房主，试试输入「支付」"
        className="lg:max-w-xs"
      />
      <fieldset className="scrollbar-none -mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 py-1.5 sm:mx-0 sm:px-0">
        <legend className="sr-only">按分组看</legend>
        {ROOM_GROUPS.map((group) => (
          <FilterChip key={group} selected={props.group === group} onClick={() => props.onGroup(group)}>
            {GROUP_LABEL[group]} {props.counts[group]}
          </FilterChip>
        ))}
      </fieldset>
      <div className="flex items-center gap-2 lg:ml-auto">
        <label htmlFor={sortId} className="text-meta text-muted">
          排序
        </label>
        <select
          id={sortId}
          value={props.sort}
          onChange={(event) => {
            const next = ROOM_SORTS.find((s) => s === event.target.value)
            if (next !== undefined) props.onSort(next)
          }}
          className="focus-ring min-h-11 rounded-xl border-2 border-line bg-surface px-3 font-semibold text-sm"
        >
          {ROOM_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABEL[sort]}
            </option>
          ))}
        </select>
        <ViewToggle view={props.view} onView={props.onView} />
      </div>
    </div>
  )
}
