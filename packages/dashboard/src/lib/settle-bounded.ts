/**
 * `Promise.allSettled` with at most `limit` calls in flight, so bulk actions (全部开门 over 99+
 * knocks) don't trip the hub's rate limit. Results keep the input order.
 */
export async function settleBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<readonly PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index] as T
      try {
        results[index] = { status: 'fulfilled', value: await run(item) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

/** What a bulk action managed: the items that went through, how many didn't, and the first reason. */
export interface BulkOutcome<T> {
  readonly done: readonly T[]
  readonly failed: number
  readonly reason?: unknown
}

/** Splits settled results; throws the first reason when nothing went through (a plain failure). */
export function bulkOutcome<T, R>(
  items: readonly T[],
  results: readonly PromiseSettledResult<R>[],
): BulkOutcome<T> {
  const done = items.filter((_, i) => results[i]?.status === 'fulfilled')
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected === undefined) return { done, failed: 0 }
  if (done.length === 0) throw rejected.reason
  return { done, failed: items.length - done.length, reason: rejected.reason }
}
