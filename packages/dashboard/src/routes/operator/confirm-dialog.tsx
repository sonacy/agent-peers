/**
 * A destructive-action confirmation (解散房间, 吊销令牌, 换管理令牌). With `confirmText`, the action
 * stays disabled until it is typed exactly, like the member view's dissolve dialog (DASHBOARD §4.3).
 */
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { ErrorBanner } from '../../components/error-banner'
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

export interface ConfirmDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: ReactNode
  readonly actionLabel: string
  readonly onConfirm: () => void
  readonly pending?: boolean
  /** Typed confirmation, e.g. the room name. */
  readonly confirmText?: string
  /** Shown when the last attempt failed. */
  readonly error?: string
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onConfirm,
  pending = false,
  confirmText,
  error,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const ready = confirmText === undefined || typed.trim() === confirmText
  const change = (next: boolean) => {
    if (!next) setTyped('')
    onOpenChange(next)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready && !pending) onConfirm()
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {confirmText === undefined ? null : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="font-semibold text-sm">
                输入 <span className="font-mono">{confirmText}</span> 确认
              </label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          )}
          {error === undefined ? null : <ErrorBanner title="没做成" description={error} />}
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
            <Button type="submit" variant="danger-outline" disabled={!ready || pending}>
              {pending ? '正在处理…' : actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
