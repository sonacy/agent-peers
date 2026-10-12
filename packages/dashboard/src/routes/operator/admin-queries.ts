/**
 * Operator data (DASHBOARD §10): TanStack queries and mutations over the admin client. There is no
 * admin event stream in the UI yet, so writes invalidate what they change and lists refresh slowly.
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isUnauthorized, signOutWith } from '../../api/errors'
import { shouldRetry } from '../../api/queries'
import { useAdminApi } from './admin-context'
import type { HubSettings, SettingsPatch } from './admin-schemas'

/** Keys under one `admin` prefix, so signing in or out resets everything at once. */
export const adminKeys = {
  all: ['admin'] as const,
  whoami: ['admin', 'whoami'] as const,
  status: ['admin', 'status'] as const,
  settings: ['admin', 'settings'] as const,
  rooms: ['admin', 'rooms'] as const,
  members: ['admin', 'members'] as const,
} as const

/** Lists change under the operator's feet (agents come and go); refresh them every 15 s. */
export const ADMIN_REFRESH_MS = 15_000

/**
 * Signed in or out: drop every cached admin answer except whoami itself, then set it. (Removing the
 * whoami query would orphan the gate's observer, which then never sees the new value.)
 */
export function setSignedIn(client: QueryClient, signedIn: boolean): void {
  client.removeQueries({ queryKey: adminKeys.all, predicate: (query) => query.queryKey[1] !== 'whoami' })
  client.setQueryData(adminKeys.whoami, signedIn)
}

export function useWhoami() {
  const api = useAdminApi()
  return useQuery({
    queryKey: adminKeys.whoami,
    // A 401 is the answer "not signed in", not an error to retry or surface.
    queryFn: async () => {
      try {
        return await api.whoami()
      } catch (error) {
        if (isUnauthorized(error)) return false
        throw error
      }
    },
    retry: shouldRetry,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useHubStatus() {
  const api = useAdminApi()
  return useQuery({
    queryKey: adminKeys.status,
    queryFn: () => api.status(),
    retry: shouldRetry,
    refetchInterval: ADMIN_REFRESH_MS,
  })
}

export function useHubSettings() {
  const api = useAdminApi()
  return useQuery({ queryKey: adminKeys.settings, queryFn: () => api.settings(), retry: shouldRetry })
}

export function useAdminRooms() {
  const api = useAdminApi()
  return useQuery({
    queryKey: adminKeys.rooms,
    queryFn: () => api.rooms(),
    retry: shouldRetry,
    refetchInterval: ADMIN_REFRESH_MS,
  })
}

export function useAdminMembers() {
  const api = useAdminApi()
  return useQuery({
    queryKey: adminKeys.members,
    queryFn: () => api.members(),
    retry: shouldRetry,
    refetchInterval: ADMIN_REFRESH_MS,
  })
}

export function useAdminLogin() {
  const api = useAdminApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (token: string) => api.login(token),
    onSuccess: () => setSignedIn(client, true),
  })
}

export function useAdminLogout() {
  const api = useAdminApi()
  const client = useQueryClient()
  // Only a confirmed logout shows the login form: a failed one leaves the admin cookie live.
  return useMutation({
    mutationFn: () => signOutWith(() => api.logout()),
    onSuccess: () => setSignedIn(client, false),
  })
}

export function usePatchSettings() {
  const api = useAdminApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.patchSettings(patch),
    onSuccess: (settings: HubSettings) => {
      client.setQueryData(adminKeys.settings, settings)
      void client.invalidateQueries({ queryKey: adminKeys.status })
    },
  })
}

export function useDissolveRoom() {
  const api = useAdminApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (roomId: string) => api.dissolveRoom(roomId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: adminKeys.rooms })
      void client.invalidateQueries({ queryKey: adminKeys.status })
      void client.invalidateQueries({ queryKey: adminKeys.members })
    },
  })
}

export function useRevokeTokens() {
  const api = useAdminApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (memberId: string) => api.revokeTokens(memberId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: adminKeys.members })
      void client.invalidateQueries({ queryKey: adminKeys.status })
    },
  })
}

export function useRotateToken() {
  const api = useAdminApi()
  return useMutation({ mutationFn: () => api.rotateToken() })
}
