/** `cn()`: clsx + tailwind-merge, taught the custom theme scales so they don't collide with colors. */
import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['page', 'section', 'card', 'meta'],
      shadow: ['hard', 'btn', 'chip'],
      animate: ['pulse-dot', 'typing', 'shimmer', 'fade-in', 'pop-in', 'sheet-up'],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
