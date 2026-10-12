/**
 * All members on the hub (DASHBOARD §10), read-only except 吊销令牌: revoking a member's tokens
 * disconnects every bridge they run; they need a new invite to come back.
 */
import { useState } from 'react'
import { EmptyState } from '../../components/empty-state'
import { ErrorBanner } from '../../components/error-banner'
import { MemberAvatar } from '../../components/member-avatar'
import { RelativeTime } from '../../components/relative-time'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { SearchInput } from '../../components/ui/input'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { useToast } from '../../components/ui/toast'
import { cn } from '../../lib/cn'
import { truncateMiddle } from '../../lib/format/text'
import { useAdminMembers, useRevokeTokens } from './admin-queries'
import type { AdminMember } from './admin-schemas'
import { ConfirmDialog } from './confirm-dialog'
import { adminErrorText } from './format'
import { PagingFooter, usePaged } from './list-paging'
import { matchMember } from './logic'

/** Phone: two lines (person + action, then the numbers). From 640px: one table row. */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_3.5rem_5rem_6.5rem_6.5rem]'
const STAT = 'tabular-nums sm:text-sm sm:text-ink'

function HeaderRow() {
  return (
    <div aria-hidden="true" className={cn(ROW_GRID, 'hidden px-4 py-2 text-meta text-muted sm:grid')}>
      <span>成员</span>
      <span>房间</span>
      <span>在线 agent</span>
      <span>加入</span>
      <span className="text-right">操作</span>
    </div>
  )
}

function MemberRow({ member, onRevoke }: { readonly member: AdminMember; readonly onRevoke: () => void }) {
  return (
    <li className={`group border-surface-2 border-t-2 px-4 py-3 max-sm:first:border-t-0 ${ROW_GRID}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <MemberAvatar memberId={member.member_id} name={member.name} size={28} decorative />
        <span className="min-w-0 truncate font-semibold text-sm" title={member.name}>
          {truncateMiddle(member.name, 28)}
        </span>
      </div>
      <div className="col-start-1 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted sm:contents">
        <span className={STAT}>
          {member.rooms}
          <span className="sm:hidden"> 个房间</span>
        </span>
        <span className={STAT}>
          {member.sessions}
          <span className="sm:hidden"> 个 agent 在线</span>
        </span>
        <span>
          <span className="sm:hidden">加入于 </span>
          <RelativeTime ts={member.created_at} />
        </span>
      </div>
      <div className="col-start-2 row-span-2 row-start-1 text-right sm:col-start-auto sm:row-span-1 sm:row-start-auto">
        <Button size="sm" variant="danger-ghost" onClick={onRevoke} aria-label={`吊销 ${member.name} 的令牌`}>
          吊销令牌
        </Button>
      </div>
    </li>
  )
}

function RevokeDialog({
  member,
  onClose,
}: {
  readonly member: AdminMember | undefined
  readonly onClose: () => void
}) {
  const revoke = useRevokeTokens()
  const { toast } = useToast()
  const confirm = () => {
    if (member === undefined) return
    revoke.mutate(member.member_id, {
      onSuccess: (count) => {
        toast({
          title: count > 0 ? `已吊销 ${member.name} 的 ${count} 个令牌` : `${member.name} 没有能用的令牌`,
          description: count > 0 ? '他的 agent 已经断开，要重新拿邀请才能回来。' : undefined,
          tone: 'success',
        })
        onClose()
      },
    })
  }
  return (
    <ConfirmDialog
      open={member !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          revoke.reset()
          onClose()
        }
      }}
      title={`吊销 ${member?.name ?? ''} 的令牌？`}
      description="他所有 agent 会立刻断开，看板也会退出登录。想回来要重新拿房主的邀请。房间里的身份不会删。"
      actionLabel="吊销令牌"
      pending={revoke.isPending}
      error={revoke.isError ? adminErrorText(revoke.error) : undefined}
      onConfirm={confirm}
    />
  )
}

export function MembersTable({ members }: { readonly members: readonly AdminMember[] }) {
  const paged = usePaged(members, matchMember)
  const [target, setTarget] = useState<AdminMember | undefined>(undefined)
  return (
    <div className="flex flex-col gap-3">
      <SearchInput label="找成员" placeholder="成员名" value={paged.query} onValueChange={paged.setQuery} />
      {paged.matched === 0 ? (
        <EmptyState
          title={members.length === 0 ? '还没有成员' : '没找到这个人'}
          description={members.length === 0 ? '第一个拿到邀请的人加入后，就会出现在这里。' : '换个名字试试。'}
        />
      ) : (
        <Card className="overflow-hidden">
          <HeaderRow />
          <ul aria-label="所有成员">
            {paged.visible.map((member) => (
              <MemberRow key={member.member_id} member={member} onRevoke={() => setTarget(member)} />
            ))}
          </ul>
        </Card>
      )}
      {paged.matched > 0 ? (
        <PagingFooter shown={paged.visible.length} total={paged.matched} onMore={paged.showMore} />
      ) : null}
      <RevokeDialog member={target} onClose={() => setTarget(undefined)} />
    </div>
  )
}

export function MembersSection() {
  const members = useAdminMembers()
  return (
    <section aria-labelledby="members-title" className="flex flex-col gap-3">
      <h2 id="members-title" className="font-display font-bold text-section">
        所有成员{' '}
        {members.data === undefined ? null : <span className="text-muted">{members.data.length}</span>}
      </h2>
      {members.isError ? (
        <ErrorBanner
          title="读不到成员列表"
          description={adminErrorText(members.error)}
          actionLabel="再试一次"
          onAction={() => void members.refetch()}
        />
      ) : members.data === undefined ? (
        <DelayedSkeleton loading fallback={<CardSkeleton />} />
      ) : (
        <MembersTable members={members.data} />
      )}
    </section>
  )
}
