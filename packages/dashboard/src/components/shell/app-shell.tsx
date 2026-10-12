/**
 * The signed-in frame (DASHBOARD §2): top bar with logo, nav pills, Core pill and avatar menu; on
 * phones a slim top bar plus the bottom tab bar. Owns the live event stream.
 */
import { Plus } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { Link, Redirect } from 'wouter'
import { isUnauthorized } from '../../api/errors'
import { useMe } from '../../api/queries'
import { LiveProvider, useLive } from '../../live/live-provider'
import { CREATE_ROOM_HREF, PATHS } from '../../routes/paths'
import { ErrorBanner, STALE_HINT, StaleData } from '../error-banner'
import { PeersLogo } from '../peers-logo'
import { Button } from '../ui/button'
import { AccountMenu } from './account-menu'
import { ConnectionBanner, LiveCorePill } from './connection'
import { BottomTabs, NavPills, useNavItems } from './nav'

type MeQuery = ReturnType<typeof useMe>

/** The phone top bar's `+`: 新建房间, held back while Core is unreachable (§5). */
function CreateRoomButton() {
  const { stale } = useLive()
  const block = (event: MouseEvent) => {
    if (stale) event.preventDefault()
  }
  return (
    <Button asChild variant="primary" size="icon" className="sm:hidden">
      <Link
        href={CREATE_ROOM_HREF}
        aria-label="新建房间"
        aria-disabled={stale || undefined}
        title={stale ? STALE_HINT : undefined}
        onClick={block}
      >
        <Plus aria-hidden="true" />
      </Link>
    </Button>
  )
}

function TopBar({ me }: { readonly me: MeQuery['data'] }) {
  const items = useNavItems()
  return (
    <>
      <header className="sticky top-0 z-40 border-line border-b-2 bg-bg">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Peers 首页" className="focus-ring shrink-0 rounded-lg">
            <PeersLogo />
          </Link>
          <NavPills items={items} />
          <div className="ml-auto flex items-center gap-2">
            <LiveCorePill className="hidden sm:inline-flex" />
            <CreateRoomButton />
            <AccountMenu me={me} />
          </div>
        </div>
      </header>
      <BottomTabs items={items} />
    </>
  )
}

/**
 * `me` never loaded (Core was down or slow on first load) and the stream isn't showing the hub
 * banner: say so and offer a retry, rather than a page with no name and no way forward.
 */
function MeErrorBanner({ me }: { readonly me: MeQuery }) {
  const { stale } = useLive()
  if (stale || !me.isError || me.data !== undefined) return null
  return (
    <ErrorBanner
      title="没拿到你的账号信息"
      description="Core 可能刚重启，或者网络断了。点重试再拉一次。"
      actionLabel={me.isFetching ? '正在重试…' : '重试'}
      onAction={() => void me.refetch()}
    />
  )
}

function Content({ me, children }: { readonly me: MeQuery; readonly children: ReactNode }) {
  const { stale } = useLive()
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-6 pb-28 sm:px-6 sm:pt-8 sm:pb-12">
      <ConnectionBanner />
      <MeErrorBanner me={me} />
      <StaleData stale={stale}>{children}</StaleData>
    </main>
  )
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const me = useMe()
  if (isUnauthorized(me.error)) return <Redirect to={PATHS.login} replace />
  // The stream starts at once, not after `me`: if Core is down on first load its backoff drives the
  // recovery (the hub banner, 现在重试, and a full refetch once it reconnects). Its own failures
  // re-ask `me`, so a 401 still lands on the redirect above.
  return (
    <LiveProvider enabled>
      <div className="flex min-h-dvh flex-col">
        <TopBar me={me.data} />
        <Content me={me}>{children}</Content>
      </div>
    </LiveProvider>
  )
}
