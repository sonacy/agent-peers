/** Provides the admin-listener client to the operator view, so tests can inject one on a fake fetch. */
import { createContext, type ReactNode, useContext, useState } from 'react'
import { type AdminClient, createAdminClient } from './admin-api'

const AdminContext = createContext<AdminClient | undefined>(undefined)

export function AdminApiProvider({
  client,
  children,
}: {
  readonly client?: AdminClient
  readonly children: ReactNode
}) {
  const [value] = useState(() => client ?? createAdminClient())
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export function useAdminApi(): AdminClient {
  const client = useContext(AdminContext)
  if (client === undefined) throw new Error('useAdminApi must be used inside <AdminApiProvider>')
  return client
}
