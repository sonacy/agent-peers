/**
 * Navigation (DASHBOARD §2): the three nav pills in the top bar and, under 640px, the bottom tab bar
 * that respects the safe area. The active item is solid ink with white text.
 */
import { Bot, DoorOpen, type LucideIcon, MessagesSquare } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { useMyRooms, useSessions } from '../../api/queries'
import { cn } from '../../lib/cn'
import { Badge } from '../ui/badge'

export interface NavItem {
  readonly href: string
  readonly label: string
  readonly icon: LucideIcon
  readonly count: number
  readonly countLabel: string
}

/** Which nav item a location belongs to. */
export function isActive(href: string, location: string): boolean {
  if (href === '/') return location === '/' || location === ''
  return location === href || location.startsWith(`${href}/`)
}

export function useNavItems(): readonly NavItem[] {
  const sessions = useSessions()
  const rooms = useMyRooms()
  const agents = sessions.data?.length ?? 0
  const knocks = (rooms.data ?? []).reduce((sum, room) => sum + (room.pending_knocks ?? 0), 0)
  return [
    { href: '/', label: '我的 agent', icon: Bot, count: agents, countLabel: `${agents} 个 agent` },
    { href: '/rooms', label: '房间', icon: DoorOpen, count: knocks, countLabel: `${knocks} 人在敲门` },
    { href: '/asks', label: '问答', icon: MessagesSquare, count: 0, countLabel: '' },
  ]
}

export function NavPills({ items }: { readonly items: readonly NavItem[] }) {
  const [location] = useLocation()
  return (
    <nav aria-label="主导航" className="hidden items-center gap-1 sm:flex">
      {items.map((item) => {
        const active = isActive(item.href, location)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border-[1.5px] px-4 font-semibold text-sm transition-colors',
              active
                ? 'border-transparent bg-active text-on-active'
                : 'border-transparent text-ink hover:bg-surface-2 dark:border-line',
            )}
          >
            <item.icon aria-hidden="true" className="size-4" />
            {item.label}
            <Badge count={item.count} label={item.countLabel} tone={active ? 'lime' : 'primary'} />
          </Link>
        )
      })}
    </nav>
  )
}

export function BottomTabs({ items }: { readonly items: readonly NavItem[] }) {
  const [location] = useLocation()
  return (
    <nav
      aria-label="底部导航"
      className="fixed inset-x-0 bottom-0 z-40 border-line border-t-2 bg-surface px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] sm:hidden"
    >
      <ul className="grid grid-cols-3 gap-1">
        {items.map((item) => {
          const active = isActive(item.href, location)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'focus-ring relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl font-semibold text-[11px]',
                  active ? 'bg-active text-on-active' : 'text-muted',
                )}
              >
                <item.icon aria-hidden="true" className="size-5" />
                {item.label}
                <Badge
                  count={item.count}
                  label={item.countLabel}
                  className="absolute top-0.5 left-[calc(50%+6px)] h-4 min-w-4 px-1 text-[10px]"
                />
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
