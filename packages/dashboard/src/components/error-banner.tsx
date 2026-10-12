/** Error states (DASHBOARD §5): the danger banner and dimmed last-known data. */
import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from './ui/button'

export interface ErrorBannerProps {
  readonly title: ReactNode
  /**
   * Text that changes while the banner is up (a countdown). It sits right after the title but
   * outside the live region, so screen readers announce the title once instead of every tick.
   */
  readonly ticker?: ReactNode
  readonly description?: ReactNode
  readonly actionLabel?: string
  readonly onAction?: () => void
  readonly className?: string
}

/** Danger-tinted banner: says what broke and offers the next step. */
export function ErrorBanner({
  title,
  ticker,
  description,
  actionLabel,
  onAction,
  className,
}: ErrorBannerProps) {
  const steady = ticker === undefined
  return (
    <div
      role={steady ? 'alert' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-2xl border-2 border-danger bg-danger-soft px-4 py-3 text-danger',
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="size-5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="font-semibold text-sm">
          {steady ? title : <span role="alert">{title}</span>}
          {steady ? null : <span data-ticker="">{ticker}</span>}
        </p>
        {description === undefined ? null : <div className="text-meta">{description}</div>}
      </div>
      {actionLabel === undefined || onAction === undefined ? null : (
        <Button size="sm" onClick={onAction} className="text-ink">
          {actionLabel}
        </Button>
      )}
    </div>
  )
}

export interface HubErrorBannerProps {
  readonly host: string
  readonly retryInSeconds: number
  readonly onRetry: () => void
  readonly className?: string
}

export const STALE_LABEL = '（上次的数据，等 Core…）'
export const STALE_HINT = '连上 Core 后再改'

/**
 * `连不上 Core（{host}），{n} 秒后重试` with 现在重试. The stale-data label rides in the banner as a
 * chip, with why the page can't be changed right now. Only `连不上 Core（{host}）` is a live region:
 * the countdown ticks every second and must not be re-announced.
 */
export function HubErrorBanner({ host, retryInSeconds, onRetry, className }: HubErrorBannerProps) {
  const when = retryInSeconds > 0 ? `${retryInSeconds} 秒后重试` : '正在重试…'
  return (
    <ErrorBanner
      className={className}
      title={`连不上 Core（${host}）`}
      ticker={`，${when}`}
      description={
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-full border-[1.5px] border-danger/40 bg-surface px-2 font-semibold text-ink">
            {STALE_LABEL}
          </span>
          <span>页面上的数据先不能改，{STALE_HINT}。</span>
        </span>
      }
      actionLabel="现在重试"
      onAction={onRetry}
    />
  )
}

export interface StaleDataProps {
  readonly stale: boolean
  readonly children: ReactNode
  readonly className?: string
}

/**
 * Keeps the last data on screen, greyed out, while Core is unreachable (the banner carries the
 * label). Desaturated rather than faded, so the text keeps its contrast and stays readable. The
 * data is `inert`, so toggles and buttons can't fire mutations; hovering explains why.
 *
 * The wrappers are always rendered and only their attributes change: swapping the element type
 * would remount the page and lose filters, paging and typed text every time Core drops.
 */
export function StaleData({ stale, children, className }: StaleDataProps) {
  return (
    <div
      aria-busy={stale || undefined}
      data-stale={stale ? 'true' : undefined}
      title={stale ? STALE_HINT : undefined}
      className={cn('flex min-w-0 flex-col', stale && 'relative cursor-not-allowed', className)}
    >
      <div
        inert={stale}
        className={cn(
          'flex min-w-0 flex-col gap-4',
          stale && 'grayscale [&_[role=switch]]:opacity-60 [&_button]:opacity-60',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** The inline note next to a submit button that can't be used while Core is unreachable. */
export function StaleHint({ stale, className }: { readonly stale: boolean; readonly className?: string }) {
  if (!stale) return null
  return (
    <p role="status" className={cn('font-semibold text-danger text-meta', className)}>
      {STALE_HINT}
    </p>
  )
}
