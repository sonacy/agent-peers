/** Big-room filters (DASHBOARD §4.3): 全部 · 有空 · 正在忙 · 离线, 只看我的, and 找人或 agent. */
import { useId } from 'react'
import type { RoomPerson } from '../../../api/types'
import { FilterChip } from '../../ui/chip'
import { SearchInput } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { filterCounts, PEOPLE_FILTER_LABEL, PEOPLE_FILTERS, type PeopleQuery } from '../model/people-model'

export interface PeopleFiltersProps {
  readonly people: readonly RoomPerson[]
  readonly query: PeopleQuery
  readonly onChange: (query: PeopleQuery) => void
}

export function PeopleFilters({ people, query, onChange }: PeopleFiltersProps) {
  const counts = filterCounts(people)
  const mineId = useId()
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchInput
        label="找人或 agent"
        placeholder="找人或 agent"
        value={query.search}
        onValueChange={(search) => onChange({ ...query, search })}
        className="sm:max-w-sm"
      />
      <div className="flex min-w-0 items-center gap-3">
        <fieldset className="scrollbar-none -ml-4 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1.5 pr-1 pl-4 sm:ml-0 sm:pl-1">
          <legend className="sr-only">按状态筛选</legend>
          {PEOPLE_FILTERS.map((filter) => (
            <FilterChip
              key={filter}
              selected={query.filter === filter}
              onClick={() => onChange({ ...query, filter })}
            >
              {PEOPLE_FILTER_LABEL[filter]}
              {filter === 'all' ? '' : ` ${counts[filter]}`}
            </FilterChip>
          ))}
        </fieldset>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            id={mineId}
            checked={query.mineOnly}
            onCheckedChange={(mineOnly) => onChange({ ...query, mineOnly })}
          />
          <label htmlFor={mineId} className="whitespace-nowrap font-semibold text-sm">
            只看我的
          </label>
        </div>
      </div>
    </div>
  )
}
