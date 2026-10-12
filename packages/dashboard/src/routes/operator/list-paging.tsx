/** Search-and-page helpers for the operator's long lists: filter client-side, show N, then more. */
import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'

export const PAGE_SIZE = 30

export interface Paged<T> {
  readonly query: string
  readonly setQuery: (query: string) => void
  readonly visible: readonly T[]
  readonly matched: number
  readonly showMore: () => void
}

/** `match(item, needle)` gets a lowercased, trimmed needle; an empty needle matches everything. */
export function usePaged<T>(
  items: readonly T[],
  match: (item: T, needle: string) => boolean,
  pageSize: number = PAGE_SIZE,
): Paged<T> {
  const [query, setQueryState] = useState('')
  const [limit, setLimit] = useState(pageSize)
  const needle = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (needle === '' ? items : items.filter((item) => match(item, needle))),
    [items, needle, match],
  )
  const setQuery = (next: string) => {
    setQueryState(next)
    setLimit(pageSize)
  }
  return {
    query,
    setQuery,
    visible: filtered.slice(0, limit),
    matched: filtered.length,
    showMore: () => setLimit((value) => value + pageSize),
  }
}

export function PagingFooter({
  shown,
  total,
  pageSize = PAGE_SIZE,
  onMore,
}: {
  readonly shown: number
  readonly total: number
  readonly pageSize?: number
  readonly onMore: () => void
}) {
  const rest = total - shown
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-meta text-muted">
      <span>
        已显示 {shown} / {total}
      </span>
      {rest > 0 ? (
        <Button size="sm" onClick={onMore}>
          再看 {Math.min(rest, pageSize)} 个
        </Button>
      ) : null}
    </div>
  )
}
