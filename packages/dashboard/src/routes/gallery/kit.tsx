/** Gallery layout helpers: a titled section and a labelled specimen. */
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** A fixed "now" so relative times render the same on every visual QA run: 2026-10-12 20:00 local. */
export const GALLERY_NOW = new Date(2026, 9, 12, 20, 0, 0).getTime()

export function GallerySection({
  id,
  title,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="font-display text-section font-bold">
        {title}
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  )
}

export function Specimen({
  label,
  children,
  wide = false,
  className,
}: {
  readonly label: string
  readonly children: ReactNode
  readonly wide?: boolean
  readonly className?: string
}) {
  return (
    <figure className={cn('m-0 flex min-w-0 flex-col gap-2', wide && 'md:col-span-2 xl:col-span-3')}>
      <figcaption className="w-fit rounded-md bg-ink-fill px-2 py-0.5 font-semibold text-[11px] text-on-ink">
        {label}
      </figcaption>
      <div className={cn('flex flex-wrap items-start gap-3', className)}>{children}</div>
    </figure>
  )
}
