import { describe, expect, it } from 'bun:test'
import { FACE_BG, FACE_COLORS, FACE_VAR, faceColor, hashString } from '../../src/lib/hash'

describe('hash → face color (§3)', () => {
  it('is stable and 32-bit unsigned', () => {
    expect(hashString('sess-1')).toBe(hashString('sess-1'))
    expect(hashString('')).toBe(0x811c9dc5)
    const h = hashString('a longer agent session id 01JABC')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(2 ** 32)
  })
  it('picks hash % 6 from the six pastels', () => {
    const id = 'sess-abc'
    expect(faceColor(id)).toBe(FACE_COLORS[hashString(id) % 6] as (typeof FACE_COLORS)[number])
  })
  it('uses every color across many ids', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => faceColor(`session-${i}`)))
    expect([...seen].sort()).toEqual([...FACE_COLORS].sort())
  })
  it('has a class and a variable per color', () => {
    for (const color of FACE_COLORS) {
      expect(FACE_BG[color]).toBe(`bg-face-${color}`)
      expect(FACE_VAR[color]).toBe(`var(--face-${color})`)
    }
  })
})
