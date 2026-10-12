/** 我的 agent, the home screen (DASHBOARD §4.1). */
import { Plus, Search } from 'lucide-react'
import { Link } from 'wouter'
import { useMe, useMyRooms, useSessions } from '../../api/queries'
import { PageHeader } from '../../components/page-header'
import { Button } from '../../components/ui/button'
import { CREATE_ROOM_HREF, FIND_ROOM_HREF } from '../paths'
import { AgentsSection } from './agents-section'
import { heroVisible, OnboardingHero, useHeroDismissal } from './onboarding-hero'
import { RecentThreads } from './recent-threads'

export function greeting(name: string | undefined): string {
  return name === undefined ? '嗨 👋' : `嗨，${name} 👋`
}

export function summaryLine(agents: number, rooms: number): string {
  return `你有 ${agents} 个 agent，在 ${rooms} 个房间里串门。`
}

export default function HomePage() {
  const me = useMe()
  const sessions = useSessions()
  const rooms = useMyRooms()
  const [dismissed, dismiss] = useHeroDismissal()
  const loaded = sessions.data !== undefined && rooms.data !== undefined
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={greeting(me.data?.name)}
        subtitle={loaded ? summaryLine(sessions.data.length, rooms.data.length) : ' '}
        actions={
          <>
            {/* Phones: the top bar's + covers 新建房间. */}
            <Button asChild variant="primary" className="max-sm:hidden">
              <Link href={CREATE_ROOM_HREF}>
                <Plus aria-hidden="true" />
                新建房间
              </Link>
            </Button>
            <Button asChild>
              <Link href={FIND_ROOM_HREF}>
                <Search aria-hidden="true" />
                找房间
              </Link>
            </Button>
          </>
        }
      />
      {rooms.data !== undefined && heroVisible(dismissed, rooms.data) ? (
        <OnboardingHero onDismiss={dismiss} />
      ) : null}
      <AgentsSection />
      <RecentThreads />
    </div>
  )
}
