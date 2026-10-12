/**
 * Heartbeat per PROTOCOL §5.1: ping after `intervalMs` without having SENT a frame (received frames
 * don't reset it); the socket is dead after 2×`intervalMs` without RECEIVING anything.
 * Timers are rescheduled lazily, so noting a frame is O(1).
 */
import type { Clock, TimerHandle } from '../util/clock'

export interface HeartbeatCallbacks {
  readonly onPing: () => void
  readonly onDead: () => void
}

export class Heartbeat {
  private lastSent = 0
  private lastReceived = 0
  private pingTimer: TimerHandle | undefined
  private deadTimer: TimerHandle | undefined
  private running = false

  constructor(
    private readonly clock: Clock,
    readonly intervalMs: number,
    private readonly callbacks: HeartbeatCallbacks,
  ) {}

  start(): void {
    const now = this.clock.now()
    this.lastSent = now
    this.lastReceived = now
    this.running = true
    this.schedulePing()
    this.scheduleDead()
  }

  noteSent(): void {
    this.lastSent = this.clock.now()
  }

  noteReceived(): void {
    this.lastReceived = this.clock.now()
  }

  stop(): void {
    this.running = false
    if (this.pingTimer !== undefined) this.clock.clearTimeout(this.pingTimer)
    if (this.deadTimer !== undefined) this.clock.clearTimeout(this.deadTimer)
    this.pingTimer = undefined
    this.deadTimer = undefined
  }

  private schedulePing(): void {
    const wait = Math.max(0, this.lastSent + this.intervalMs - this.clock.now())
    this.pingTimer = this.clock.setTimeout(() => {
      if (!this.running) return
      if (this.clock.now() - this.lastSent >= this.intervalMs) {
        this.lastSent = this.clock.now()
        this.callbacks.onPing()
      }
      if (this.running) this.schedulePing()
    }, wait)
  }

  private scheduleDead(): void {
    const limit = this.intervalMs * 2
    const wait = Math.max(0, this.lastReceived + limit - this.clock.now())
    this.deadTimer = this.clock.setTimeout(() => {
      if (!this.running) return
      if (this.clock.now() - this.lastReceived >= limit) {
        this.stop()
        this.callbacks.onDead()
        return
      }
      this.scheduleDead()
    }, wait)
  }
}
