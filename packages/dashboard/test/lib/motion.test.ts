import { describe, expect, it } from 'bun:test'
import {
  allowWobble,
  ENTRANCE_MS,
  entrance,
  STAGGER_LIMIT,
  staggerDelay,
  WOBBLE_MAX_CARDS,
} from '../../src/lib/motion'

describe('motion budget (§9)', () => {
  it('staggers only the first 6 items', () => {
    expect(staggerDelay(0)).toBe(0)
    expect(staggerDelay(5)).toBeCloseTo(0.25)
    expect(staggerDelay(STAGGER_LIMIT)).toBe(0)
    expect(staggerDelay(-1)).toBe(0)
  })
  it('keeps every entrance within 550ms', () => {
    for (let i = 0; i < STAGGER_LIMIT; i++) {
      const { transition, initial } = entrance(i, false)
      expect(initial).not.toBe(false)
      expect((transition.delay + transition.duration) * 1000).toBeCloseTo(ENTRANCE_MS)
    }
  })
  it('renders items past the limit and reduced motion in place', () => {
    expect(entrance(6, false).initial).toBe(false)
    expect(entrance(0, true).initial).toBe(false)
    expect(entrance(0, true).transition.duration).toBe(0)
  })
  it('turns hover wobble off past 30 cards or with reduced motion', () => {
    expect(allowWobble(WOBBLE_MAX_CARDS, false)).toBe(true)
    expect(allowWobble(WOBBLE_MAX_CARDS + 1, false)).toBe(false)
    expect(allowWobble(3, true)).toBe(false)
  })
})
