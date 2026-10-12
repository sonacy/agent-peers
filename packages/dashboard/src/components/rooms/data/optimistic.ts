/**
 * The optimistic-mutation pattern for the room screens: patch the cache at once, roll back and
 * toast (why + what next) if the hub refuses, then refetch what changed. SSE refreshes everyone else.
 */
import { type QueryClient, type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { friendlyError } from '../../../api/errors'
import { useToast } from '../../ui/toast'

/** One cache entry to patch: its key and how to change it. */
export interface CachePatch {
  readonly key: QueryKey
  readonly update: (value: unknown) => unknown
}

/** A typed patch: the cache holds a `T` under `key` (TanStack stores values untyped). */
export function patchOf<T>(key: QueryKey, update: (value: T) => T): CachePatch {
  return { key, update: (value) => update(value as T) }
}

/** The same patch for every cached query under a key prefix (e.g. each room search). */
export function patchAll<T>(client: QueryClient, prefix: QueryKey, update: (value: T) => T): CachePatch[] {
  return client.getQueriesData<T>({ queryKey: prefix }).map(([key]) => patchOf(key, update))
}

type Snapshot = ReadonlyArray<readonly [QueryKey, unknown]>

export async function applyPatches(client: QueryClient, patches: readonly CachePatch[]): Promise<Snapshot> {
  await Promise.all(patches.map((p) => client.cancelQueries({ queryKey: p.key, exact: true })))
  return patches.map((patch) => {
    const previous = client.getQueryData(patch.key)
    if (previous !== undefined) client.setQueryData(patch.key, patch.update(previous))
    return [patch.key, previous] as const
  })
}

export function restore(client: QueryClient, snapshot: Snapshot | undefined): void {
  for (const [key, previous] of snapshot ?? []) {
    if (previous !== undefined) client.setQueryData(key, previous)
  }
}

/** Applies patches at once, without cancelling queries (used after a partial success). */
function applyNow(client: QueryClient, patches: readonly CachePatch[]): void {
  for (const patch of patches) {
    const previous = client.getQueryData(patch.key)
    if (previous !== undefined) client.setQueryData(patch.key, patch.update(previous))
  }
}

/** A bulk action that only partly went through: what did, and the danger toast saying so. */
export interface PartialResult<V> {
  readonly applied: V
  readonly title: string
  readonly reason: unknown
}

export interface OptimisticOptions<V, R> {
  readonly mutationFn: (vars: V) => Promise<R>
  /** Cache entries to patch before the request goes out. */
  readonly patches?: (vars: V, client: QueryClient) => readonly CachePatch[]
  /** Queries to refetch once the hub answers (success or failure). */
  readonly refetch: (vars: V) => readonly QueryKey[]
  readonly errorTitle: string
  /** Toast shown on success, if any. */
  readonly successToast?: (result: R, vars: V) => string | undefined
  readonly onSuccess?: (result: R, vars: V) => void
  /**
   * Bulk actions: when only some items went through, keep exactly those changes (not all, not
   * none) and say how many didn't. Undefined means the whole action succeeded.
   */
  readonly partial?: (result: R, vars: V) => PartialResult<V> | undefined
}

export function useOptimistic<V, R>(options: OptimisticOptions<V, R>) {
  const client = useQueryClient()
  const { toast } = useToast()
  return useMutation({
    mutationFn: options.mutationFn,
    onMutate: (vars: V) => applyPatches(client, options.patches?.(vars, client) ?? []),
    onError: (error, _vars, snapshot) => {
      restore(client, snapshot)
      toast({ title: options.errorTitle, description: friendlyError(error), tone: 'danger' })
    },
    onSuccess: (result, vars, snapshot) => {
      const partial = options.partial?.(result, vars)
      if (partial !== undefined) {
        restore(client, snapshot)
        applyNow(client, options.patches?.(partial.applied, client) ?? [])
        toast({ title: partial.title, description: friendlyError(partial.reason), tone: 'danger' })
        return
      }
      const message = options.successToast?.(result, vars)
      if (message !== undefined) toast({ title: message, tone: 'success' })
      options.onSuccess?.(result, vars)
    },
    onSettled: async (_result, _error, vars) => {
      await Promise.all(options.refetch(vars).map((queryKey) => client.invalidateQueries({ queryKey })))
    },
  })
}
