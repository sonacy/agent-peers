import { describe, expect, it } from 'bun:test'
import { cn } from '../../src/lib/cn'

describe('cn', () => {
  it('keeps custom font sizes next to text colors', () => {
    expect(cn('text-page text-ink')).toBe('text-page text-ink')
    expect(cn('text-meta', 'text-card')).toBe('text-card')
  })
  it('merges conflicting utilities and drops falsy values', () => {
    expect(cn('bg-face-violet', false && 'x', undefined, 'bg-face-cloud')).toBe('bg-face-cloud')
    expect(cn('shadow-hard', 'shadow-none')).toBe('shadow-none')
  })
})
