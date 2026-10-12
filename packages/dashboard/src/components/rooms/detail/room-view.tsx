/**
 * The loaded room (DASHBOARD §4.3): hero, then two columns at ≥1024px (people + a 320px side column
 * with 拉朋友进来, 有人在敲门 and 被请出的人). Phones split into 成员 / 邀请 / 敲门 tabs.
 */
import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'wouter'
import type { RoomDetail } from '../../../api/types'
import { formatCount } from '../../../lib/format/count'
import { PATHS } from '../../../routes/paths'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { isBigRoom, ownerName } from '../model/people-model'
import { roomTitle } from '../model/rooms-model'
import { PeopleSection } from '../people/people-section'
import { InvitePanel } from '../side/invite-panel'
import { KickedPanel } from '../side/kicked-panel'
import { KnocksPanel } from '../side/knocks-panel'
import { MemberNote } from '../side/member-note'
import { RoomHero } from './room-hero'

export interface RoomViewProps {
  readonly detail: RoomDetail
  readonly phone: boolean
  readonly focusInvite: boolean
  readonly onGone: () => void
}

function OwnerKnocks({ detail }: { readonly detail: RoomDetail }) {
  return (
    <>
      <KnocksPanel
        roomId={detail.room.room_id}
        roomName={roomTitle(detail.room)}
        knocks={detail.knocks ?? []}
      />
      <KickedPanel roomId={detail.room.room_id} kicked={detail.kicked ?? []} />
    </>
  )
}

function InviteOrNote({ detail, focus }: { readonly detail: RoomDetail; readonly focus: boolean }) {
  return detail.my_role === 'owner' ? (
    <InvitePanel detail={detail} focus={focus} />
  ) : (
    <MemberNote owner={ownerName(detail)} />
  )
}

function PhoneTabs({ detail, focusInvite }: Pick<RoomViewProps, 'detail' | 'focusInvite'>) {
  const owner = detail.my_role === 'owner'
  const knocks = detail.knocks?.length ?? 0
  return (
    <Tabs defaultValue={focusInvite ? 'invite' : 'people'} className="flex flex-col gap-4">
      <TabsList aria-label="房间分区">
        <TabsTrigger value="people">成员</TabsTrigger>
        <TabsTrigger value="invite">邀请</TabsTrigger>
        {owner ? (
          <TabsTrigger value="knocks">敲门{knocks > 0 ? ` ${formatCount(knocks)}` : ''}</TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="people">
        <PeopleSection detail={detail} />
      </TabsContent>
      <TabsContent value="invite">
        <InviteOrNote detail={detail} focus={focusInvite} />
      </TabsContent>
      {owner ? (
        <TabsContent value="knocks" className="flex flex-col gap-4">
          <OwnerKnocks detail={detail} />
        </TabsContent>
      ) : null}
    </Tabs>
  )
}

function Columns({ detail, focusInvite }: Pick<RoomViewProps, 'detail' | 'focusInvite'>) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <PeopleSection detail={detail} />
      <aside aria-label="邀请和敲门" className="flex flex-col gap-4">
        <InviteOrNote detail={detail} focus={focusInvite} />
        {detail.my_role === 'owner' ? <OwnerKnocks detail={detail} /> : null}
      </aside>
    </div>
  )
}

function BackLink(): ReactNode {
  return (
    <Link
      href={PATHS.rooms}
      className="focus-ring inline-flex min-h-11 items-center gap-1 self-start rounded-lg font-semibold text-muted text-sm hover:text-ink"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      全部房间
    </Link>
  )
}

export function RoomView({ detail, phone, focusInvite, onGone }: RoomViewProps) {
  const compact = phone || isBigRoom(detail)
  return (
    <div className="flex flex-col gap-6">
      {compact ? null : <BackLink />}
      <RoomHero detail={detail} compact={compact} phone={phone} onGone={onGone} />
      {phone ? (
        <PhoneTabs detail={detail} focusInvite={focusInvite} />
      ) : (
        <Columns detail={detail} focusInvite={focusInvite} />
      )}
    </div>
  )
}
