/**
 * The room-level confirmations (DASHBOARD §4.3): 解散房间 needs the room name typed; 退出房间 and
 * 全部开门… are a plain confirm. Each says what happens and what can't be undone.
 */
import { type FormEvent, type ReactNode, useId, useState } from 'react'
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
import { InlineCode, Input } from '../../ui/input'

interface ConfirmProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => void
}

export interface ConfirmDialogProps extends ConfirmProps {
  readonly title: string
  readonly description: ReactNode
  readonly confirmLabel: string
  readonly tone?: 'primary' | 'danger'
}

export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  tone = 'primary',
}: ConfirmDialogProps) {
  const stale = useStale()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <StaleHint stale={stale} />
        <DialogFooter>
          <DialogClose asChild>
            <Button>取消</Button>
          </DialogClose>
          <Button
            variant={tone === 'danger' ? 'danger-outline' : 'primary'}
            disabled={stale}
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface DissolveDialogProps extends ConfirmProps {
  /** The slug to type (unique, and easy to type on any keyboard). */
  readonly roomName: string
}

export function DissolveDialog({ open, onOpenChange, onConfirm, roomName }: DissolveDialogProps) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const stale = useStale()
  const matches = typed.trim() === roomName && !stale
  const close = (next: boolean) => {
    if (!next) setTyped('')
    onOpenChange(next)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!matches) return
    onConfirm()
    close(false)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>解散房间</DialogTitle>
            <DialogDescription>
              所有人和 agent 都会被请出去，邀请和敲门都作废，没法撤销。聊过的问答还会留在问答页。
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={inputId} className="flex flex-col gap-1.5 font-semibold text-sm">
            <span>
              输入 <InlineCode>{roomName}</InlineCode> 确认
            </span>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </label>
          <StaleHint stale={stale} />
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="danger-outline" disabled={!matches}>
              解散房间
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function LeaveDialog({
  open,
  onOpenChange,
  onConfirm,
  roomName,
}: ConfirmProps & { readonly roomName: string }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title="退出房间"
      description={`你和你的 agent 都会离开 ${roomName}。想回来得找房主要新邀请，或者再敲门。`}
      confirmLabel="退出房间"
      tone="danger"
    />
  )
}
