/** Text input and the search box (找房间: `房间名或房主，比如 api`). */
import { Search, X } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

const FIELD =
  'min-h-11 w-full rounded-xl border-2 border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus-ring disabled:opacity-50'

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type ?? 'text'} className={cn(FIELD, className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(FIELD, 'min-h-24 py-2.5', className)} {...props} />
}

export interface SearchInputProps extends Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange'> {
  readonly value: string
  readonly onValueChange: (value: string) => void
  /** Accessible name; the placeholder is not a label. */
  readonly label: string
}

export function SearchInput({ value, onValueChange, label, className, ...props }: SearchInputProps) {
  return (
    <div className={cn('relative w-full', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(FIELD, 'shadow-btn pr-11 pl-9 [&::-webkit-search-cancel-button]:hidden')}
        {...props}
      />
      {value === '' ? null : (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => onValueChange('')}
          className="focus-ring absolute top-1/2 right-0.5 inline-flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-muted hover:text-ink"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

/** Inline command, e.g. `/peers:room new 名字`. */
export function InlineCode({ className, ...props }: ComponentProps<'code'>) {
  return (
    <code
      className={cn(
        'rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-ink break-all',
        className,
      )}
      {...props}
    />
  )
}
