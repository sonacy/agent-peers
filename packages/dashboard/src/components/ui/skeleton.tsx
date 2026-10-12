/** Skeletons (DASHBOARD §5): shown only when loading takes longer than 300ms. */
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { SKELETON_DELAY_MS, useDelayedFlag } from '../../lib/hooks/use-delayed-flag'

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div aria-hidden="true" className={cn('rounded-lg bg-surface-2 animate-shimmer', className)} {...props} />
  )
}

export interface DelayedSkeletonProps {
  readonly loading: boolean
  /** What to show while loading, once the delay has passed. */
  readonly fallback: ReactNode
  readonly children?: ReactNode
  readonly delayMs?: number
  /** Announced to screen readers while loading. */
  readonly label?: string
}

/** Renders nothing for the first `delayMs` of a load, then the fallback; children once loaded. */
export function DelayedSkeleton({
  loading,
  fallback,
  children,
  delayMs = SKELETON_DELAY_MS,
  label = '加载中…',
}: DelayedSkeletonProps) {
  const show = useDelayedFlag(loading, delayMs)
  if (!loading) return <>{children}</>
  if (!show) return null
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {fallback}
    </div>
  )
}

/** A card-shaped placeholder: face square plus two text lines. */
export function CardSkeleton({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl border-2 border-surface-2 bg-surface p-4',
        className,
      )}
    >
      <Skeleton className="size-11 shrink-0 rounded-xl" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </div>
  )
}
