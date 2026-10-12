import type { Clock } from '../../src/clock'

/** Manually advanced clock for deterministic timer tests. */
export class FakeClock implements Clock {
  private time: number
  private nextId = 1
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  constructor(start = 1_800_000_000_000) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.time = Math.max(this.time, due[1].at)
      due[1].fn()
    }
    this.time = target
  }
}
