/**
 * Room hero band (DASHBOARD §4.3): violet-soft, the big door, the name in display type, chips, and
 * 解散房间 (owner, confirm by typing) or 退出房间 (member). Big rooms get a slim band; phones get one
 * compact row (‹ name ⋯) over a single horizontally scrolling chip row, with the action in a sheet.
 */
import { ChevronLeft } from 'lucide-react'
import { Link } from 'wouter'
import type { RoomDetail } from '../../../api/types'
import { cn } from '../../../lib/cn'
import { formatDate } from '../../../lib/format/time'
import { PATHS } from '../../../routes/paths'
import { RoomDoor } from '../../room-door'
import { Button } from '../../ui/button'
import { Chip } from '../../ui/chip'
import { agentCount, idleCount } from '../model/people-model'
import { roomTitle } from '../model/rooms-model'
import { HeroAction } from './hero-actions'

export interface RoomHeroProps {
  readonly detail: RoomDetail
  readonly compact: boolean
  /** Below 640px: the one-row phone hero. */
  readonly phone?: boolean
  /** Where to go after leaving or dissolving. */
  readonly onGone: () => void
}

export function roleLine(role: RoomDetail['my_role']): string {
  if (role === 'owner') return '你是房主'
  return role === 'readonly' ? '你是只读成员' : '你是成员'
}

function HeroChips({
  detail,
  compact,
  className,
}: Pick<RoomHeroProps, 'detail' | 'compact'> & { readonly className?: string }) {
  const agents = agentCount(detail.people)
  const idle = idleCount(detail.people.flatMap((p) => p.agents))
  const created = detail.room.created_at
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      <Chip tone={detail.my_role === 'owner' ? 'lime' : 'outline'} className="shrink-0">
        {roleLine(detail.my_role)}
      </Chip>
      <Chip className="shrink-0">
        {detail.people.length} 人 · {agents} 个 agent
      </Chip>
      {compact ? (
        <Chip className="shrink-0">
          <span aria-hidden="true" className="size-2 rounded-full bg-ok" />
          {idle} 个有空
        </Chip>
      ) : null}
      {created === undefined || compact ? null : <Chip className="shrink-0">{formatDate(created)} 创建</Chip>}
    </div>
  )
}

function BackButton() {
  return (
    <Button asChild size="icon-sm" variant="ghost" className="-ml-1">
      <Link href={PATHS.rooms} aria-label="回到全部房间">
        <ChevronLeft aria-hidden="true" />
      </Link>
    </Button>
  )
}

const BAND = 'rounded-2xl border-2 border-line bg-primary-soft shadow-hard'

function PhoneHero({ detail, onGone }: Pick<RoomHeroProps, 'detail' | 'onGone'>) {
  const name = roomTitle(detail.room)
  return (
    <header data-hero="phone" className={cn(BAND, 'flex flex-col gap-2 py-2 pr-2 pl-2')}>
      <div className="flex min-w-0 items-center gap-1">
        <BackButton />
        <h1 className="min-w-0 flex-1 truncate font-display font-extrabold text-section" title={name}>
          {name}
        </h1>
        <HeroAction detail={detail} onGone={onGone} menu />
      </div>
      <HeroChips detail={detail} compact className="scrollbar-none flex-nowrap overflow-x-auto px-1 pb-1" />
    </header>
  )
}

export function RoomHero({ detail, compact, phone = false, onGone }: RoomHeroProps) {
  if (phone) return <PhoneHero detail={detail} onGone={onGone} />
  const name = roomTitle(detail.room)
  return (
    <header
      className={cn(
        BAND,
        'flex gap-4',
        compact ? 'flex-row items-center p-3 sm:px-4' : 'flex-col p-5 sm:flex-row sm:items-center sm:p-6',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
        {compact ? (
          <BackButton />
        ) : (
          <RoomDoor roomId={detail.room.room_id} size={64} face onBand className="hidden sm:inline-flex" />
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <h1
            className={cn(
              'truncate font-display font-extrabold',
              compact ? 'text-section' : 'text-[28px] sm:text-page',
            )}
            title={name}
          >
            {name}
          </h1>
          <HeroChips detail={detail} compact={compact} />
          {detail.room.description === undefined || compact ? null : (
            <p className="text-ink/80 text-sm">{detail.room.description}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 sm:self-start">
        <HeroAction detail={detail} onGone={onGone} />
      </div>
    </header>
  )
}
