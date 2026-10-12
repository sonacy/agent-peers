/**
 * Live updates for signed-in screens (DASHBOARD §7, §11): one event stream per tab feeding the query
 * cache, plus the connection status behind the Core pill, the hub-error banner and stale dimming.
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { queryKeys } from '../api/keys'
import { applyMemberEvent } from './apply-event'
import {
  browserEventSource,
  type CreateEventSource,
  connectMemberEvents,
  INITIAL_STATUS,
  type LiveStatus,
  type StreamHandle,
} from './stream'

/** Lets tests (and the gallery) swap the EventSource implementation. */
const EventSourceContext = createContext<CreateEventSource | undefined>(undefined)

export function EventSourceProvider({
  createSource,
  children,
}: {
  readonly createSource?: CreateEventSource
  readonly children: ReactNode
}) {
  return <EventSourceContext.Provider value={createSource}>{children}</EventSourceContext.Provider>
}

export interface LiveValue {
  readonly status: LiveStatus
  /** Core is unreachable: show the last data dimmed (§5). */
  readonly stale: boolean
  readonly retryNow: () => void
}

const LiveContext = createContext<LiveValue>({ status: INITIAL_STATUS, stale: false, retryNow: () => {} })

export function LiveProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean
  readonly children: ReactNode
}) {
  const client = useQueryClient()
  const injected = useContext(EventSourceContext)
  const [status, setStatus] = useState<LiveStatus>(INITIAL_STATUS)
  const handle = useRef<StreamHandle | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return
    const createSource = injected ?? browserEventSource()
    if (createSource === undefined) return
    const stream = connectMemberEvents({
      createSource,
      onEvent: (event) => applyMemberEvent(client, event),
      onStatus: setStatus,
      onResync: () => void client.invalidateQueries(),
      // A revoked or expired cookie fails the stream like a dead hub would: asking `me` again turns
      // a 401 into the sign-in redirect instead of a banner whose retry can never work.
      onFailure: () => void client.invalidateQueries({ queryKey: queryKeys.me }),
    })
    handle.current = stream
    return () => {
      stream.close()
      handle.current = undefined
    }
  }, [client, enabled, injected])

  const retryNow = useCallback(() => handle.current?.retryNow(), [])
  const value = useMemo(
    () => ({ status, stale: status.state === 'disconnected', retryNow }),
    [status, retryNow],
  )
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive(): LiveValue {
  return useContext(LiveContext)
}

/** True while Core is unreachable: mutations wait until it is back (DASHBOARD §5). */
export function useStale(): boolean {
  return useContext(LiveContext).stale
}
