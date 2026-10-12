/** Segmented control (问答: 全部 · 我问的 · 问我的): a single-choice radio group in the tabs style. */
import { ToggleGroup } from 'radix-ui'
import { cn } from '../../lib/cn'
import { segmentedItemClass, segmentedListClass } from './tabs'

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: string
}

export interface SegmentedProps<T extends string> {
  readonly value: T
  readonly options: readonly SegmentedOption<T>[]
  readonly onValueChange: (value: T) => void
  readonly label: string
  readonly className?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onValueChange,
  label,
  className,
}: SegmentedProps<T>) {
  const select = (next: string): void => {
    const option = options.find((o) => o.value === next)
    if (option !== undefined) onValueChange(option.value)
  }
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={select}
      aria-label={label}
      className={cn(segmentedListClass, className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} value={option.value} className={segmentedItemClass}>
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
