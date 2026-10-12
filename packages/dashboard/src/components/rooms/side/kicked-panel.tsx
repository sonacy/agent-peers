/** 被请出的人 (DASHBOARD §4.3): collapsible `▸ 被请出的 5 人`, each with 恢复. */
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { KickedMember } from '../../../api/types'
import { cn } from '../../../lib/cn'
import { MemberAvatar } from '../../member-avatar'
import { RelativeTime } from '../../relative-time'
import { TruncatedText } from '../../truncated-text'
import { Button } from '../../ui/button'
import { useRestorePerson } from '../data/use-room-actions'

export function KickedPanel({
  roomId,
  kicked,
}: {
  readonly roomId: string
  readonly kicked: readonly KickedMember[]
}) {
  const [open, setOpen] = useState(false)
  const restore = useRestorePerson(roomId)
  if (kicked.length === 0) return null
  return (
    <section className="rounded-2xl border-2 border-line bg-surface shadow-btn">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="focus-ring flex min-h-11 w-full cursor-pointer items-center gap-1.5 rounded-2xl px-4 py-2 font-semibold text-sm"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('size-4 transition-transform', open && 'rotate-90')}
          />
          被请出的 {kicked.length} 人
        </button>
      </h2>
      {open ? (
        <ul aria-label="被请出的人" className="flex flex-col gap-2 px-4 pb-4">
          {kicked.map((k) => (
            <li key={k.member_id} className="flex items-center gap-2.5">
              <MemberAvatar memberId={k.member_id} name={k.member} size={28} decorative />
              <div className="flex min-w-0 flex-1 flex-col">
                <TruncatedText text={k.member} middle={22} className="font-semibold text-sm" />
                <span className="text-meta text-muted">
                  <RelativeTime ts={k.kicked_at} /> 请出
                </span>
              </div>
              <Button
                size="sm"
                onClick={() => restore.mutate({ memberId: k.member_id, name: k.member })}
                aria-label={`恢复 ${k.member}`}
              >
                恢复
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
