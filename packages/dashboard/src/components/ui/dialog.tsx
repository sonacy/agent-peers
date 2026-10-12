/**
 * Dialog on Radix (DASHBOARD §4, §9). Centered card from 640px up; below that it becomes a bottom
 * sheet with full-width buttons, so every dialog follows the phone rule without extra code.
 */
import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-50 bg-ink-fill/45 animate-fade-in', className)}
      {...props}
    />
  )
}

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hide the corner close button (e.g. when the footer has 取消). */
  readonly hideClose?: boolean
}

export function DialogContent({ className, children, hideClose = false, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col gap-4 overflow-y-auto',
          'rounded-t-3xl border-2 border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink',
          'shadow-hard animate-sheet-up focus:outline-none',
          'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2',
          'sm:rounded-2xl sm:pb-5 sm:animate-pop-in',
          '[&_[data-slot=dialog-footer]_button]:max-sm:w-full',
          className,
        )}
        {...props}
      >
        <div
          aria-hidden="true"
          className="mx-auto -mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted/30 sm:hidden"
        />
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            aria-label="关闭"
            className="focus-ring absolute top-3 right-3 inline-flex size-11 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-5" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-10', className)} {...props} />
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('font-display text-section font-bold', className)} {...props} />
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-muted text-sm', className)} {...props} />
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

/** Visually hidden but announced: for dialogs whose title is implied by the layout. */
export function SrOnly({ children }: { readonly children: ReactNode }) {
  return <span className="sr-only">{children}</span>
}
