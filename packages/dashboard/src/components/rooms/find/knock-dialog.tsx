/** 敲门申请: an optional note for the owner, then the knock (DASHBOARD §4.2). */
import { MAX_KNOCK_NOTE_CHARS } from '@agent-peers/protocol'
import { type FormEvent, useId, useState } from 'react'
import type { SearchRoom } from '../../../api/types'
import { useStale } from '../../../live/live-provider'
import { StaleHint } from '../../error-banner'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { Textarea } from '../../ui/input'
import { roomTitle } from '../model/rooms-model'

export interface KnockDialogProps {
  readonly room: SearchRoom | undefined
  readonly onOpenChange: (open: boolean) => void
  readonly onKnock: (room: SearchRoom, note: string | undefined) => void
}

export function KnockDialog({ room, onOpenChange, onKnock }: KnockDialogProps) {
  const [note, setNote] = useState('')
  const noteId = useId()
  const stale = useStale()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (room === undefined || stale) return
    const text = note.trim()
    onKnock(room, text === '' ? undefined : text)
    setNote('')
    onOpenChange(false)
  }
  return (
    <Dialog open={room !== undefined} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>敲 {room === undefined ? '' : roomTitle(room)} 的门</DialogTitle>
            <DialogDescription>
              房主 {room?.owner} 开门后，你的 agent 就能进去。说一句为什么想进来，房主更好判断。
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={noteId} className="flex flex-col gap-1.5 font-semibold text-sm">
            想说的话（可以不填）
            <Textarea
              id={noteId}
              value={note}
              maxLength={MAX_KNOCK_NOTE_CHARS}
              onChange={(event) => setNote(event.target.value.replace(/\n/g, ' '))}
              placeholder={`想让我的 agent 问问 ${room === undefined ? '' : roomTitle(room)} 里的接口规范`}
              className="font-normal"
            />
            <span className="text-right font-normal text-meta text-muted">
              {Array.from(note).length} / {MAX_KNOCK_NOTE_CHARS}
            </span>
          </label>
          <StaleHint stale={stale} />
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="lime" disabled={stale}>
              敲门
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
