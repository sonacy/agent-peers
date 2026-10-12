/** Page header (DASHBOARD §4): display title (34px), a muted subline and right-aligned actions. */
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface PageHeaderProps {
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
  readonly className?: string
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="break-words font-display font-extrabold text-[28px] leading-tight sm:text-page">
          {title}
        </h1>
        {subtitle === undefined ? null : <p className="text-muted text-sm">{subtitle}</p>}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  )
}

/** Section title row (我的 agent, 刚刚聊过): 20px display heading with optional trailing content. */
export function SectionHeader({
  title,
  id,
  children,
}: {
  readonly title: string
  readonly id?: string
  readonly children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 id={id} className="font-display font-bold text-section">
        {title}
      </h2>
      {children}
    </div>
  )
}
