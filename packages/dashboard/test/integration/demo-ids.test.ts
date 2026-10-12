import { describe, expect, it } from 'bun:test'
import { isUlid } from '@agent-peers/protocol'
import { createDemoIds, DEMO_ID_EPOCH, encodeTime, seededRandom } from '../../scripts/demo/ids'

describe('demo ids', () => {
  it('repeats the same valid, increasing ULIDs for the same seed', () => {
    const a = createDemoIds()
    const b = createDemoIds()
    const first = Array.from({ length: 50 }, () => a())
    expect(Array.from({ length: 50 }, () => b())).toEqual(first)
    expect(first.every((id) => isUlid(id))).toBe(true)
    expect([...first].sort()).toEqual(first)
    expect(new Set(first).size).toBe(first.length)
    expect(first[0]?.slice(0, 10)).toBe(encodeTime(DEMO_ID_EPOCH))
  })

  it('differs by seed and rejects impossible times', () => {
    expect(createDemoIds(1)()).not.toBe(createDemoIds(2)())
    expect(() => encodeTime(-1)).toThrow()
    const random = seededRandom(7)
    const values = Array.from({ length: 100 }, () => random())
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true)
  })
})
