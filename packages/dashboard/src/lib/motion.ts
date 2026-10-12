/** Motion budget (DASHBOARD §9): entrances ≤ 550ms, only the first 6 list items stagger. */

export const ENTRANCE_MS = 550
export const STAGGER_LIMIT = 6
export const STAGGER_STEP_MS = 50
export const PRESS_MS = 80
/** Hover wobble turns off when more than this many cards are on screen. */
export const WOBBLE_MAX_CARDS = 30

const EASE_OUT: readonly [number, number, number, number] = [0.22, 1, 0.36, 1]

/** Delay (seconds) before list item `index` enters: staggered for the first 6, instant after. */
export function staggerDelay(index: number): number {
  if (index < 0 || index >= STAGGER_LIMIT) return 0
  return (index * STAGGER_STEP_MS) / 1000
}

export interface EntranceProps {
  readonly initial: false | { readonly opacity: number; readonly y: number }
  readonly animate: { readonly opacity: number; readonly y: number }
  readonly transition: {
    readonly duration: number
    readonly delay: number
    readonly ease: readonly [number, number, number, number]
  }
}

const SETTLED = { opacity: 1, y: 0 } as const

/**
 * Props for a `motion` element entering a list. Items past the stagger limit, and everything under
 * reduced motion, render in place with no animation. Delay + duration never exceed ENTRANCE_MS.
 */
export function entrance(index: number, reduced: boolean): EntranceProps {
  if (reduced || index >= STAGGER_LIMIT) {
    return { initial: false, animate: SETTLED, transition: { duration: 0, delay: 0, ease: EASE_OUT } }
  }
  const delay = staggerDelay(index)
  return {
    initial: { opacity: 0, y: 8 },
    animate: SETTLED,
    transition: { duration: ENTRANCE_MS / 1000 - delay, delay, ease: EASE_OUT },
  }
}

/** Hover wobble is allowed only with motion on and at most WOBBLE_MAX_CARDS cards on screen. */
export function allowWobble(cardsOnScreen: number, reduced: boolean): boolean {
  return !reduced && cardsOnScreen <= WOBBLE_MAX_CARDS
}
