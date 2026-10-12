/**
 * Bottom sheet (DASHBOARD §4.3 mobile person sheet): always docked to the bottom, drag handle on top,
 * full-width actions at least 44px tall. Built on the Radix dialog for focus trapping and Escape.
 */
import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { DialogOverlay } from './dialog'

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

export function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto',
          'rounded-t-3xl border-2 border-line border-b-0 bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
          'text-ink animate-sheet-up focus:outline-none',
          className,
        )}
        {...props}
      >
        <div aria-hidden="true" className="mx-auto -mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted/30" />
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('font-display text-lg font-bold', className)} {...props} />
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-muted text-sm', className)} {...props} />
}

/** A stack of full-width sheet actions. */
export function SheetActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col gap-2 [&_button]:w-full [&_button]:min-h-12', className)} {...props} />
  )
}
