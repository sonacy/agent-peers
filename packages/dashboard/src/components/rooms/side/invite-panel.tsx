/**
 * 拉朋友进来 (DASHBOARD §4.3, owner only): a lime panel with the masked invite preview, 复制邀请
 * (copies the full join prompt), 换一个邀请码 and 关闭邀请; when closed, a grey card with 重新开启.
 */
import { Copy, Lock, TriangleAlert } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Invite, RoomDetail } from '../../../api/types'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { useToast } from '../../ui/toast'
import { copyText } from '../copy'
import { useInviteAction } from '../data/use-room-actions'

/**
 * The preview never shows the real code: line 1 is the opening of the join prompt (one sentence,
 * one ellipsis), line 2 the masked code. The copy button copies the real prompt.
 */
export function invitePreview(roomName: string, invite: Invite): readonly [string, string] {
  return [`[peers invite] Join the Peers room "${roomName}" …`, `Code: ${invite.code_masked}`]
}

/**
 * Line 1 wraps only between words, and the quoted room name never breaks: a name too long for the
 * column is clipped with an ellipsis. Line 2 (the masked code) stays on one line.
 */
function InvitePreview({ roomName, invite }: { readonly roomName: string; readonly invite: Invite }) {
  const [line, code] = invitePreview(roomName, invite)
  const quoted = `"${roomName}" …`
  return (
    <figure className="flex flex-col">
      <figcaption className="sr-only">邀请预览</figcaption>
      <div
        data-invite-preview="true"
        title={`${line}\n${code}`}
        className="flex flex-col gap-0.5 rounded-xl bg-ink-fill p-3 font-mono text-on-ink text-xs leading-relaxed"
      >
        <span className="block">
          {line.slice(0, line.length - quoted.length)}
          <span className="inline-block max-w-full truncate whitespace-pre align-bottom">{quoted}</span>
        </span>
        <span className="block truncate whitespace-pre">{code}</span>
      </div>
    </figure>
  )
}

export function LoopbackWarning() {
  return (
    <p className="flex gap-2 rounded-xl border-2 border-line/20 bg-warn p-3 text-meta text-warn-ink">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      邀请里的 Core 地址是 localhost，同事的电脑连不上。部署到大家都能访问的地址再发。
    </p>
  )
}

function ClosedInvite({ roomId }: { readonly roomId: string }) {
  const reopen = useInviteAction(roomId, 'reopen')
  return (
    <Card tone="muted" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 font-display font-bold text-card">
        <Lock aria-hidden="true" className="size-4" />
        邀请已关闭
      </h2>
      <p className="text-muted text-sm">之前发出去的邀请都失效了，新的人只能敲门。</p>
      <Button
        variant="lime"
        onClick={() => reopen.mutate()}
        disabled={reopen.isPending}
        className="whitespace-normal"
      >
        重新开启（生成新邀请码）
      </Button>
    </Card>
  )
}

function useCopyInvite(prompt: string | null | undefined) {
  const { toast } = useToast()
  return async () => {
    if (prompt === null || prompt === undefined) return
    const ok = await copyText(prompt)
    toast(
      ok
        ? { title: '已复制，粘到群里吧', tone: 'success' }
        : {
            title: '没复制成功',
            description: '浏览器不让写剪贴板。用 https 地址打开，或者换个浏览器再试。',
            tone: 'danger',
          },
    )
  }
}

export interface InvitePanelProps {
  readonly detail: RoomDetail
  /** Just created: move focus to 复制邀请. */
  readonly focus?: boolean
}

export function InvitePanel({ detail, focus = false }: InvitePanelProps) {
  const roomId = detail.room.room_id
  const invite = detail.invite
  const copyRef = useRef<HTMLButtonElement>(null)
  const copy = useCopyInvite(detail.join_prompt)
  const rotate = useInviteAction(roomId, 'rotate')
  const close = useInviteAction(roomId, 'close')
  const open = invite !== null && invite !== undefined && invite.state === 'active'
  useEffect(() => {
    if (focus && open) copyRef.current?.focus()
  }, [focus, open])
  if (!open) return <ClosedInvite roomId={roomId} />
  const noPrompt = detail.join_prompt === null || detail.join_prompt === undefined
  return (
    <Card tone="lime" className="flex flex-col gap-3 p-4">
      <h2 className="font-display font-bold text-section">拉朋友进来</h2>
      <p className="text-sm">
        复制邀请发给同事，他贴给自己的 agent 就进来了。邀请一直有效，直到你换掉或关掉。
      </p>
      {invite.loopback === true ? <LoopbackWarning /> : null}
      <InvitePreview roomName={detail.room.name} invite={invite} />
      {noPrompt ? (
        <p className="text-meta">
          Core 还没有对外地址（public_url），邀请生成不出来。请运维在设置里填好再来复制。
        </p>
      ) : null}
      <Button ref={copyRef} variant="primary" block onClick={() => void copy()} disabled={noPrompt}>
        <Copy aria-hidden="true" />
        复制邀请
      </Button>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          size="sm"
          className="max-sm:min-h-11"
          onClick={() => rotate.mutate()}
          disabled={rotate.isPending}
        >
          换一个邀请码
        </Button>
        <Button
          size="sm"
          className="max-sm:min-h-11"
          onClick={() => close.mutate()}
          disabled={close.isPending}
        >
          关闭邀请
        </Button>
      </div>
    </Card>
  )
}
