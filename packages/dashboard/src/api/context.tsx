/** Provides the member-API client to hooks, so tests can inject one backed by a fake fetch. */
import { createContext, type ReactNode, useContext, useState } from 'react'
import { type ApiClient, createApiClient } from './client'

const ApiContext = createContext<ApiClient | undefined>(undefined)

export function ApiProvider({
  client,
  children,
}: {
  readonly client?: ApiClient
  readonly children: ReactNode
}) {
  const [value] = useState(() => client ?? createApiClient())
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext)
  if (client === undefined) throw new Error('useApi must be used inside <ApiProvider>')
  return client
}
