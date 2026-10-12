/**
 * 有人在敲门 (DASHBOARD §4.3, owner only): a blush-tinted list with a 99+ badge; each knock has 开门
 * and 先不了. Past 3 knocks: 全部 N 条 expands the list and 全部开门… lets everyone in after a confirm.
 */
import { Hand } from 'lucide-react'
import { useState } from 'react'
import type { Knock } from '../../../api/types'
import { MemberAvatar } from '../../member-avatar'
import { RelativeTime } from '../../relative-time'
import { TruncatedText } from '../../truncated-text'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { Chip } from '../../ui/chip'
import { useDecideKnocks } from '../data/use-room-actions'
import { ConfirmDialog } from '../detail/confirm-dialogs'

/** Knocks shown before 全部 N 条. */
export const KNOCK_PREVIEW = 3

interface KnockItemProps {
  readonly knock: Knock
  readonly onDecide: (knock: Knock, decision: 'accept' | 'decline') => void
}

function KnockItem({ knock, onDecide }: KnockItemProps) {
  return (
    <li
      aria-label={`${knock.member} 在敲门`}
      className="flex flex-col gap-2.5 rounded-xl border-2 border-line/15 bg-knock-item p-3 dark:border-l-[3px] dark:border-l-blush"
    >
      <div className="flex items-center gap-2.5">
        <MemberAvatar memberId={knock.member_id ?? knock.member} name={knock.member} size={32} decorative />
        <div className="flex min-w-0 flex-1 flex-col">
          <TruncatedText text={knock.member} middle={22} className="font-semibold text-sm" />
          <RelativeTime ts={knock.created_at} className="text-meta text-muted" />
        </div>
        {knock.previously_removed === true ? <Chip tone="warn">之前被请出过</Chip> : null}
      </div>
      {knock.note === null || knock.note === undefined || knock.note === '' ? null : (
        <blockquote className="break-words rounded-lg bg-surface px-3 py-2 text-sm">{knock.note}</blockquote>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => onDecide(knock, 'accept')}
          aria-label={`给 ${knock.member} 开门`}
        >
          开门
        </Button>
        <Button
          size="sm"
          onClick={() => onDecide(knock, 'decline')}
          aria-label={`先不给 ${knock.member} 开门`}
        >
          先不了
        </Button>
      </div>
    </li>
  )
}

export interface KnocksPanelProps {
  readonly roomId: string
  readonly roomName: string
  readonly knocks: readonly Knock[]
}

export function KnocksPanel({ roomId, roomName, knocks }: KnocksPanelProps) {
  const decide = useDecideKnocks(roomId)
  const [all, setAll] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const many = knocks.length > KNOCK_PREVIEW
  const shown = many && !all ? knocks.slice(0, KNOCK_PREVIEW) : knocks
  const onDecide = (knock: Knock, decision: 'accept' | 'decline') =>
    decide.mutate({ knocks: [knock], decision })
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 font-display font-bold text-section">
        <Hand aria-hidden="true" className="size-4 text-danger" />
        有人在敲门
        <Badge count={knocks.length} tone="blush" label={`${knocks.length} 人在敲门`} />
      </h2>
      {knocks.length === 0 ? (
        <p className="text-muted text-sm">现在没人敲门。有人敲门会马上出现在这里。</p>
      ) : null}
      <ul aria-label="敲门的人" className="flex flex-col gap-2.5">
        {shown.map((knock) => (
          <KnockItem key={knock.knock_id} knock={knock} onDecide={onDecide} />
        ))}
      </ul>
      {many ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? '收起' : `全部 ${knocks.length} 条`}
          </Button>
          <Button size="sm" onClick={() => setConfirming(true)}>
            全部开门…
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => decide.mutate({ knocks, decision: 'accept' })}
        title="全部开门"
        description={`让敲门的 ${knocks.length} 个人都以成员身份进 ${roomName}？他们的 agent 进来后就能互相提问。`}
        confirmLabel={`给 ${knocks.length} 个人开门`}
      />
    </Card>
  )
}
