/**
 * 新建房间 (DASHBOARD §4.2): name (a Chinese display name is fine; the slug is derived from it and
 * can be edited), an optional description and 能被找到. A bottom sheet on phones (the Dialog does it).
 */
import { isValidName, MAX_LINE_CHARS, MAX_TITLE_CHARS, toNameSlug } from '@agent-peers/protocol'
import { type FormEvent, useId, useState } from 'react'
import { friendlyError } from '../../api/errors'
import type { CreateRoomInput } from '../../api/types'
import { cn } from '../../lib/cn'
import { useStale } from '../../live/live-provider'
import { StaleHint } from '../error-banner'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { useCreateRoom } from './data/use-room-lifecycle'

export interface CreateRoomDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Called with the new room's id once the hub created it. */
  readonly onCreated: (roomId: string) => void
}

export interface RoomDraft {
  readonly name: string
  readonly slug: string
  readonly description: string
  readonly discoverable: boolean
}

/** The slug shown under the name: derived until the person edits it. */
export function draftSlug(name: string, edited: string | undefined): string {
  if (edited !== undefined) return edited
  return name.trim() === '' ? '' : toNameSlug(name.trim())
}

/** The create body: the slug is the room name; the typed name is kept when it differs. */
export function createInput(draft: RoomDraft): CreateRoomInput {
  const display = draft.name.trim()
  const description = draft.description.trim()
  return {
    name: draft.slug,
    ...(display !== '' && display !== draft.slug ? { display_name: display } : {}),
    ...(description === '' ? {} : { description }),
    discoverable: draft.discoverable,
  }
}

const LABEL = 'flex flex-col gap-1.5 font-semibold text-sm'
const HINT = 'font-normal text-meta text-muted'

export function CreateRoomDialog({ open, onOpenChange, onCreated }: CreateRoomDialogProps) {
  const create = useCreateRoom()
  const stale = useStale()
  const [name, setName] = useState('')
  const [edited, setEdited] = useState<string | undefined>(undefined)
  const [description, setDescription] = useState('')
  const [discoverable, setDiscoverable] = useState(true)
  const ids = { name: useId(), slug: useId(), hint: useId(), desc: useId(), find: useId() }
  const slug = draftSlug(name, edited)
  const slugInvalid = slug !== '' && !isValidName(slug)
  const ready = name.trim() !== '' && isValidName(slug)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || stale || create.isPending) return
    try {
      const created = await create.mutateAsync(createInput({ name, slug, description, discoverable }))
      onOpenChange(false)
      onCreated(created.room.room_id)
    } catch {
      // Shown inline below (create.error); the dialog stays open so nothing typed is lost.
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新建房间</DialogTitle>
            <DialogDescription>建好后把邀请发给同事，他们的 agent 就能进来互相提问。</DialogDescription>
          </DialogHeader>
          <label htmlFor={ids.name} className={LABEL}>
            房间名
            <Input
              id={ids.name}
              value={name}
              maxLength={MAX_TITLE_CHARS}
              onChange={(event) => setName(event.target.value)}
              placeholder="比如 支付联调 或 api-review"
              autoComplete="off"
              required
            />
          </label>
          <label htmlFor={ids.slug} className={LABEL}>
            链接名（agent 里用 /peers:join 它）
            <Input
              id={ids.slug}
              value={slug}
              onChange={(event) => setEdited(event.target.value.toLowerCase())}
              aria-invalid={slugInvalid}
              aria-describedby={ids.hint}
              className={cn('font-mono', slugInvalid && 'border-danger')}
              autoComplete="off"
              spellCheck={false}
            />
            <span id={ids.hint} className={cn(HINT, slugInvalid && 'text-danger')}>
              小写字母、数字、- 和 _，以字母或数字开头，最多 32 个字。中文名会自动生成一个。
            </span>
          </label>
          <label htmlFor={ids.desc} className={LABEL}>
            简介（可以不填）
            <Input
              id={ids.desc}
              value={description}
              maxLength={MAX_LINE_CHARS}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个房间聊什么"
            />
            <span className={cn(HINT, 'text-right')}>
              {Array.from(description).length} / {MAX_LINE_CHARS}
            </span>
          </label>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2">
            <label htmlFor={ids.find} className="flex flex-col font-semibold text-sm">
              能被找到
              <span className={HINT}>打开后，别人能在「找房间」里搜到它并敲门。</span>
            </label>
            <Switch id={ids.find} checked={discoverable} onCheckedChange={setDiscoverable} />
          </div>
          {create.isError ? (
            <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-danger text-sm">
              没建成：{friendlyError(create.error)}
            </p>
          ) : null}
          <StaleHint stale={stale} />
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={!ready || stale || create.isPending}>
              {create.isPending ? '正在建…' : '建好了，去发邀请'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
