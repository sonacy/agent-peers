/**
 * Operator view (DASHBOARD §10): the same SPA mounted at `/admin` on the admin listener. Signed in
 * with the admin token (cookie); shows hub status, settings, every room and member, and token
 * rotation. Member screens are not available here.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { isUnauthorized } from '../../api/errors'
import { ErrorBanner } from '../../components/error-banner'
import { PageHeader } from '../../components/page-header'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import type { AdminClient } from './admin-api'
import { AdminApiProvider } from './admin-context'
import { adminKeys, setSignedIn, useWhoami } from './admin-queries'
import { adminErrorText } from './format'
import { HubStatusSection } from './hub-status'
import { MembersSection } from './members-list'
import { OperatorLogin } from './operator-login'
import { OperatorShell } from './operator-shell'
import { RoomsSection } from './rooms-list'
import { RotateTokenSection } from './rotate-token'
import { SettingsSection } from './settings-form'

/** Any admin request answered 401 (cookie expired, token rotated elsewhere) goes back to sign-in. */
function useSignInAgainOnUnauthorized(): void {
  const client = useQueryClient()
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        const { query } = event
        if (event.type !== 'updated') return
        if (query.queryKey[0] !== adminKeys.all[0] || query.queryKey[1] === 'whoami') return
        if (isUnauthorized(query.state.error)) setSignedIn(client, false)
      }),
    [client],
  )
}

function OperatorConsole() {
  useSignInAgainOnUnauthorized()
  return (
    <OperatorShell>
      <PageHeader
        title="Core 运维"
        subtitle="这台 hub 的状态、设置、所有房间和成员。只在 hub 这台机器上能打开。"
      />
      <HubStatusSection />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-8">
          <RoomsSection />
          <MembersSection />
        </div>
        <aside aria-label="设置和令牌" className="flex flex-col gap-6">
          <SettingsSection />
          <RotateTokenSection />
        </aside>
      </div>
    </OperatorShell>
  )
}

function Gate() {
  const whoami = useWhoami()
  if (whoami.isError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center px-4">
        <ErrorBanner
          className="w-full"
          title="连不上 Core"
          description={adminErrorText(whoami.error)}
          actionLabel="再试一次"
          onAction={() => void whoami.refetch()}
        />
      </main>
    )
  }
  if (whoami.data === undefined) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <DelayedSkeleton loading fallback={<CardSkeleton />} />
      </main>
    )
  }
  return whoami.data ? <OperatorConsole /> : <OperatorLogin />
}

export interface OperatorAppProps {
  /** Admin-listener client; defaults to same-origin fetch. */
  readonly api?: AdminClient
}

export default function OperatorApp({ api }: OperatorAppProps) {
  return (
    <AdminApiProvider client={api}>
      <Gate />
    </AdminApiProvider>
  )
}
