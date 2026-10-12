/** Status indicator (DASHBOARD §3): mark + text label, so status is never color-only. */
import { type AgentStatus, STATUS_LABEL } from '../lib/agent'
import { cn } from '../lib/cn'

function Mark({ status }: { readonly status: AgentStatus }) {
  switch (status) {
    case 'idle':
      return <span data-mark="pulse" className="size-2 shrink-0 rounded-full bg-ok animate-pulse-dot" />
    case 'busy':
      return (
        <svg
          data-mark="spinner"
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="size-3 shrink-0 animate-spin text-busy"
        >
          <circle
            cx="6"
            cy="6"
            r="4.5"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2"
          />
          <path
            d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'offline':
      return <span data-mark="ring" className="size-2.5 shrink-0 rounded-full border-[1.5px] border-muted" />
    case 'awaiting':
      return <span data-mark="dot" className="size-2 shrink-0 rounded-full bg-busy" />
  }
}

export interface StatusProps {
  readonly status: AgentStatus
  /** After the label: `25 秒前`, `正在回答一个问题`. */
  readonly detail?: string
  readonly className?: string
}

export function Status({ status, detail, className }: StatusProps) {
  return (
    <span
      data-status={status}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-meta', className)}
    >
      <span aria-hidden="true" className="inline-flex">
        <Mark status={status} />
      </span>
      <span className={cn('shrink-0 font-semibold', status === 'offline' ? 'text-muted' : 'text-ink')}>
        {STATUS_LABEL[status]}
      </span>
      {detail === undefined || detail === '' ? null : <span className="truncate text-muted">· {detail}</span>}
    </span>
  )
}
