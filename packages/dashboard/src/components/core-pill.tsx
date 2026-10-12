/** The Core pill (DASHBOARD §7): the SSE connection to the hub, in the top bar. */
import { cn } from '../lib/cn'
import { useNow } from '../lib/hooks/use-now'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export const CORE_STATES = ['connected', 'reconnecting', 'disconnected'] as const
export type CoreState = (typeof CORE_STATES)[number]

export interface CoreDetails {
  readonly url: string
  readonly lastError?: string
  /** Epoch ms of the next reconnect attempt. */
  readonly nextRetryAt?: number
}

const LABEL: Readonly<Record<CoreState, string>> = {
  connected: 'Core 已连接',
  reconnecting: '正在连 Core…',
  disconnected: '连不上 Core',
}

const PILL =
  'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] px-3 text-meta font-semibold'

function Mark({ state }: { readonly state: CoreState }) {
  if (state === 'connected') return <span data-mark="dot" className="size-2 rounded-full bg-ok" />
  if (state === 'reconnecting') {
    return (
      <span
        data-mark="dashed"
        className="size-2.5 rounded-full border-[1.5px] border-dashed border-muted animate-spin"
      />
    )
  }
  return <span data-mark="ring" className="size-2.5 rounded-full border-[1.5px] border-danger" />
}

/** Seconds until `at`, never negative. */
export function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000))
}

export interface CorePillProps {
  readonly state: CoreState
  readonly details?: CoreDetails
  readonly now?: number
  readonly className?: string
}

export function CorePill({ state, details, now, className }: CorePillProps) {
  const pill = (
    <span className={cn('inline-flex', className)} role="status" aria-live="polite">
      <span
        data-state={state}
        className={cn(
          PILL,
          state === 'disconnected'
            ? 'border-danger bg-danger-soft text-danger'
            : 'border-line bg-surface text-ink',
        )}
      >
        <span aria-hidden="true" className="inline-flex">
          <Mark state={state} />
        </span>
        {LABEL[state]}
      </span>
    </span>
  )
  if (state !== 'disconnected' || details === undefined) return pill
  // A popover, not a hover card: hover cards ignore touch and clicks, so tablets and a mouse click
  // could never reach the URL, the last error and the next retry (§7).
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${LABEL[state]}，查看详情`}
          className="focus-ring inline-flex min-h-11 cursor-pointer items-center rounded-full"
        >
          {pill}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Core 连接详情">
        <CoreDetailsCard details={details} now={now} />
      </PopoverContent>
    </Popover>
  )
}

export function CoreDetailsCard({ details, now }: { readonly details: CoreDetails; readonly now?: number }) {
  const ticking = useNow(1000)
  const at = now ?? ticking
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-meta">
      <dt className="text-muted">地址</dt>
      <dd className="break-all font-mono">{details.url}</dd>
      <dt className="text-muted">上次错误</dt>
      <dd className="break-words">{details.lastError ?? '没有返回错误信息'}</dd>
      <dt className="text-muted">下次重试</dt>
      <dd>{details.nextRetryAt === undefined ? '马上' : `${secondsUntil(details.nextRetryAt, at)} 秒后`}</dd>
    </dl>
  )
}
