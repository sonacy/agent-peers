/**
 * AgentCard (DASHBOARD §4.1): face, title (2 lines), tool and model chips, status line,
 * reachability or outdated-plugin notice, room tags (2 then +N) and the 接受提问 toggle.
 */
import { CircleAlert, House, MoreHorizontal } from 'lucide-react'
import { motion } from 'motion/react'
import { useId, useState } from 'react'
import { usePatchSession } from '../../api/mutations'
import type { SessionCard } from '../../api/types'
import { AgentFace } from '../../components/agent-face'
import { ReachabilityHint, WarnBox } from '../../components/reachability-hint'
import { Status } from '../../components/status'
import { TruncatedText } from '../../components/truncated-text'
import { Button } from '../../components/ui/button'
import { Card, CardFooter } from '../../components/ui/card'
import { Chip } from '../../components/ui/chip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { Switch } from '../../components/ui/switch'
import { useToast } from '../../components/ui/toast'
import { type AgentStatus, agentKindLabel, agentStatus, outdatedPluginText } from '../../lib/agent'
import { formatOverflow } from '../../lib/format/count'
import { formatAgo } from '../../lib/format/time'
import { useNow } from '../../lib/hooks/use-now'
import { entrance } from '../../lib/motion'
import { useMotionPreference } from '../../lib/motion-preference'
import { useStale } from '../../live/live-provider'
import { RemoveFromRoomDialog, RenameDialog } from './agent-dialogs'

export const MAX_ROOM_TAGS = 2

/** The title, or `{tool} · {host}` for untitled sessions. */
export function cardTitle(card: SessionCard): string {
  const title = card.title?.trim()
  return title === undefined || title === '' ? `${agentKindLabel(card.agent.kind)} · ${card.host}` : title
}

export function statusDetail(card: SessionCard, status: AgentStatus, now: number): string | undefined {
  if (status === 'idle') return formatAgo(card.last_activity_at, now)
  if (status === 'offline') return formatAgo(card.last_seen_at, now)
  if (status === 'busy') return card.summary
  return undefined
}

export function upgradeCommand(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | sh`
}

function OutdatedNotice({ card }: { readonly card: SessionCard }) {
  const { toast } = useToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(upgradeCommand(location.origin))
      toast({
        title: '已复制升级命令',
        description: '在终端里运行，然后完全退出再打开这个 agent。',
        tone: 'success',
      })
    } catch {
      toast({ title: '没复制成', description: '浏览器不让写剪贴板，手动复制一下吧。', tone: 'danger' })
    }
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <WarnBox icon={<CircleAlert />}>
        {outdatedPluginText(card.agent.adapter ?? card.agent.version ?? '旧版本')}
      </WarnBox>
      <Button size="sm" variant="lime" onClick={copy}>
        复制升级命令
      </Button>
    </div>
  )
}

function RoomTags({
  card,
  roomName,
}: {
  readonly card: SessionCard
  readonly roomName: (id: string) => string
}) {
  if (card.rooms.length === 0) return null
  const shown = card.rooms.slice(0, MAX_ROOM_TAGS)
  const hidden = card.rooms.length - shown.length
  return (
    <ul
      className="order-2 flex min-w-0 max-w-[60%] justify-end gap-1.5 sm:order-none sm:max-w-full sm:flex-wrap sm:justify-start"
      aria-label="所在房间"
    >
      {shown.map((r) => (
        <li key={r.room_id} className="min-w-0 max-w-full">
          <Chip tone="violet" className="max-w-full">
            <House aria-hidden="true" />
            <TruncatedText text={roomName(r.room_id)} />
          </Chip>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <Chip tone="ink" aria-label={`还有 ${hidden} 个房间`}>
            {formatOverflow(hidden)}
          </Chip>
        </li>
      ) : null}
    </ul>
  )
}

type DialogKind = 'rename' | 'remove' | undefined

function CardMenu({
  card,
  title,
  onOpen,
}: {
  readonly card: SessionCard
  readonly title: string
  readonly onOpen: (kind: DialogKind) => void
}) {
  const patch = usePatchSession(card.session_id)
  const stale = useStale()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${title} 的更多操作`} className="-mt-1 -mr-1">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => onOpen('rename')}>改名</DropdownMenuItem>
        <DropdownMenuItem disabled={card.rooms.length === 0} onSelect={() => onOpen('remove')}>
          移出房间…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={stale}
          onSelect={() => patch.mutate({ sessionId: card.session_id, patch: { accepting: !card.accepting } })}
        >
          {card.accepting ? '暂停' : '恢复接受提问'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface AgentCardProps {
  readonly card: SessionCard
  readonly roomName: (roomId: string) => string
  readonly index?: number
  /** Hover wobble (off with reduced motion or more than 30 cards on screen, §9). */
  readonly wobble?: boolean
}

export function AgentCard({ card, roomName, index = 0, wobble = false }: AgentCardProps) {
  const { reduced } = useMotionPreference()
  const now = useNow()
  const patch = usePatchSession(card.session_id)
  const [dialog, setDialog] = useState<DialogKind>(undefined)
  const switchId = useId()
  const status = agentStatus(card)
  const title = cardTitle(card)
  const dialogProps = { card, title, roomName, open: true, onOpenChange: () => setDialog(undefined) }
  return (
    <motion.li
      {...entrance(index, reduced)}
      whileHover={wobble ? { rotate: -0.6, y: -2 } : undefined}
      className="flex"
    >
      <Card
        className="flex w-full min-w-0 flex-col"
        aria-label={title}
        role="article"
        data-session-id={card.session_id}
      >
        <div className="flex flex-1 flex-col gap-2.5 p-3.5 sm:gap-3 sm:p-4">
          <div className="flex items-start gap-3">
            <AgentFace id={card.session_id} size={44} expression={status} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <TruncatedText text={title} lines={2} tooltip as="h3" className="font-semibold text-card" />
              <div className="flex min-w-0 flex-wrap gap-1">
                <Chip>{agentKindLabel(card.agent.kind)}</Chip>
                {card.model ? (
                  <Chip tone="violet" className="min-w-0 max-w-full">
                    <TruncatedText text={card.model} tooltip />
                  </Chip>
                ) : null}
              </div>
            </div>
            <CardMenu card={card} title={title} onOpen={setDialog} />
          </div>
          {/* Phones: status left, room tags right on one row, the notice under them (§9 compact cards). */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:flex-col sm:flex-nowrap sm:items-stretch sm:gap-3">
            <Status
              status={status}
              detail={statusDetail(card, status, now)}
              className="order-1 flex-1 sm:order-none sm:flex-none"
            />
            <div className="order-3 empty:hidden basis-full sm:order-none">
              {card.outdated ? <OutdatedNotice card={card} /> : <ReachabilityHint card={card} />}
            </div>
            <RoomTags card={card} roomName={roomName} />
          </div>
        </div>
        {/* Phones toggle 接受提问 from the ⋯ menu (暂停 / 恢复接受提问). */}
        <CardFooter className="hidden sm:flex">
          <label htmlFor={switchId} className="font-semibold text-sm">
            接受提问
          </label>
          <Switch
            id={switchId}
            checked={card.accepting}
            onCheckedChange={(accepting) =>
              patch.mutate({ sessionId: card.session_id, patch: { accepting } })
            }
          />
        </CardFooter>
      </Card>
      {dialog === 'rename' ? <RenameDialog {...dialogProps} /> : null}
      {dialog === 'remove' ? <RemoveFromRoomDialog {...dialogProps} /> : null}
    </motion.li>
  )
}
