/** 改名 and 移出房间… dialogs from an agent card's `⋯` menu (DASHBOARD §4.1). */
import { isValidName, MAX_TITLE_CHARS } from '@agent-peers/protocol'
import { type FormEvent, useId, useState } from 'react'
import { usePatchSession, useRemoveFromRoom } from '../../api/mutations'
import type { SessionCard, SessionPatch } from '../../api/types'
import { StaleHint } from '../../components/error-banner'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import { useStale } from '../../live/live-provider'

export interface AgentDialogProps {
  readonly card: SessionCard
  readonly title: string
  readonly roomName: (roomId: string) => string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

/** The PATCH body for a rename: only what changed; undefined when nothing did. */
export function renamePatch(
  card: SessionCard,
  title: string,
  roomId: string | undefined,
  handle: string,
): SessionPatch | undefined {
  const nextTitle = title.trim()
  const current = card.rooms.find((r) => r.room_id === roomId)
  const titlePatch = nextTitle !== '' && nextTitle !== (card.title ?? '') ? { title: nextTitle } : {}
  const handlePatch =
    current !== undefined && handle !== current.handle ? { handle, room_id: current.room_id } : {}
  const patch = { ...titlePatch, ...handlePatch }
  return Object.keys(patch).length === 0 ? undefined : patch
}

const LABEL = 'flex flex-col gap-1.5 text-sm font-semibold'
const HINT = 'text-meta font-normal text-muted'

function HandleField({
  card,
  roomName,
  roomId,
  setRoomId,
  handle,
  setHandle,
  invalid,
}: {
  readonly card: SessionCard
  readonly roomName: (roomId: string) => string
  readonly roomId: string | undefined
  readonly setRoomId: (id: string) => void
  readonly handle: string
  readonly setHandle: (handle: string) => void
  readonly invalid: boolean
}) {
  const ids = { room: useId(), handle: useId(), hint: useId() }
  if (card.rooms.length === 0) return null
  return (
    <>
      {card.rooms.length > 1 ? (
        <label htmlFor={ids.room} className={LABEL}>
          在哪个房间改 @名字
          <select
            id={ids.room}
            value={roomId}
            onChange={(event) => {
              setRoomId(event.target.value)
              setHandle(card.rooms.find((r) => r.room_id === event.target.value)?.handle ?? '')
            }}
            className="focus-ring min-h-11 rounded-xl border-2 border-line bg-surface px-3 font-normal"
          >
            {card.rooms.map((r) => (
              <option key={r.room_id} value={r.room_id}>
                {roomName(r.room_id)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label htmlFor={ids.handle} className={LABEL}>
        @名字（同房间的 agent 用它找到它）
        <div className="relative">
          <span aria-hidden="true" className="absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            @
          </span>
          <Input
            id={ids.handle}
            value={handle}
            onChange={(event) => setHandle(event.target.value.toLowerCase())}
            aria-invalid={invalid}
            aria-describedby={ids.hint}
            className={cn('pl-7 font-mono', invalid && 'border-danger')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <span id={ids.hint} className={cn(HINT, invalid && 'text-danger')}>
          小写字母、数字、- 和 _，以字母或数字开头，最多 32 个字。
        </span>
      </label>
    </>
  )
}

export function RenameDialog({ card, title, roomName, open, onOpenChange }: AgentDialogProps) {
  const patch = usePatchSession(card.session_id, '没改成名字')
  const [nextTitle, setTitle] = useState(card.title ?? '')
  const [roomId, setRoomId] = useState(card.rooms[0]?.room_id)
  const [handle, setHandle] = useState(card.rooms[0]?.handle ?? '')
  const titleId = useId()
  const stale = useStale()
  const invalid = card.rooms.length > 0 && !isValidName(handle)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (invalid || stale) return
    const body = renamePatch(card, nextTitle, roomId, handle)
    if (body !== undefined) patch.mutate({ sessionId: card.session_id, patch: body })
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>改名</DialogTitle>
            <DialogDescription>改「{title}」的标题和它在房间里的 @名字。</DialogDescription>
          </DialogHeader>
          <label htmlFor={titleId} className={LABEL}>
            标题
            <Input
              id={titleId}
              value={nextTitle}
              maxLength={MAX_TITLE_CHARS}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="这个对话在做什么"
            />
          </label>
          <HandleField {...{ card, roomName, roomId, setRoomId, handle, setHandle, invalid }} />
          <StaleHint stale={stale} />
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={invalid || stale}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveFromRoomDialog({ card, title, roomName, open, onOpenChange }: AgentDialogProps) {
  const remove = useRemoveFromRoom(card.session_id)
  const stale = useStale()
  const [roomId, setRoomId] = useState(card.rooms[0]?.room_id)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (roomId === undefined || stale) return
    remove.mutate({ sessionId: card.session_id, roomId })
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>移出房间</DialogTitle>
            <DialogDescription>
              「{title}」会让出它在那个房间的 @名字，你自己还在房间里，之后可以再让它 /peers:join 回来。
            </DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-semibold text-sm">从哪个房间移出</legend>
            {card.rooms.map((r) => (
              <label
                key={r.room_id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border-2 border-line px-3 has-[:checked]:bg-primary-tint"
              >
                <input
                  type="radio"
                  name="room"
                  value={r.room_id}
                  checked={roomId === r.room_id}
                  onChange={() => setRoomId(r.room_id)}
                  className="size-4 accent-[var(--primary)]"
                />
                <span className="min-w-0 flex-1 truncate font-semibold">⌂ {roomName(r.room_id)}</span>
                <span className="font-mono text-meta text-muted">@{r.handle}</span>
              </label>
            ))}
          </fieldset>
          <StaleHint stale={stale} />
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="danger-outline" disabled={roomId === undefined || stale}>
              移出房间
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
