/** App-wide providers: API client, data cache, live events, reduced motion, tooltips and toasts. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { ApiClient } from './api/client'
import { ApiProvider } from './api/context'
import { shouldRetry } from './api/queries'
import { ToastProvider } from './components/ui/toast'
import { TooltipProvider } from './components/ui/tooltip'
import { MotionPreferenceProvider } from './lib/motion-preference'
import { EventSourceProvider } from './live/live-provider'
import type { CreateEventSource } from './live/stream'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Live updates arrive over SSE (DASHBOARD §11), so no focus refetch or polling.
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetry },
      mutations: { retry: false },
    },
  })
}

export interface ProvidersProps {
  readonly children: ReactNode
  readonly client?: QueryClient
  /** Member-API client; defaults to same-origin fetch. */
  readonly api?: ApiClient
  /** EventSource factory for `/v0/me/events`; defaults to the browser's. */
  readonly createEventSource?: CreateEventSource
}

export function Providers({ children, client, api, createEventSource }: ProvidersProps) {
  const [queryClient] = useState(() => client ?? createQueryClient())
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        <EventSourceProvider createSource={createEventSource}>
          <MotionPreferenceProvider>
            <TooltipProvider delayDuration={300}>
              <ToastProvider>{children}</ToastProvider>
            </TooltipProvider>
          </MotionPreferenceProvider>
        </EventSourceProvider>
      </ApiProvider>
    </QueryClientProvider>
  )
}
