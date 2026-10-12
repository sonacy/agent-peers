/** Small async coordination helpers: change signals, inline ask waiters and a debounced card patch. */
import type { Clock, TimerHandle } from '@agent-peers/core'
import {
  ACTIVITY_DEBOUNCE_MS,
  type AskState,
  type DeepReadonly,
  type Message,
  type SessionPatch,
} from '@agent-peers/protocol'

export type PeerMessage = DeepReadonly<Message>
export type WaitOutcome = 'changed' | 'timeout' | 'aborted'

/** Wakes every pending `wait` on the next `notify`. */
export class ChangeSignal {
  private waiters: readonly ((outcome: WaitOutcome) => void)[] = []

  notify(): void {
    const current = this.waiters
    this.waiters = []
    for (const wake of current) wake('changed')
  }

  wait(clock: Clock, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (signal?.aborted) return Promise.resolve('aborted')
    return new Promise<WaitOutcome>((resolve) => {
      let timer: TimerHandle | undefined
      const finish = (outcome: WaitOutcome) => {
        if (timer !== undefined) clock.clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters = this.waiters.filter((w) => w !== finish)
        resolve(outcome)
      }
      const onAbort = () => finish('aborted')
      timer = clock.setTimeout(() => finish('timeout'), Math.max(0, ms))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters = [...this.waiters, finish]
    })
  }
}

/** What an inline `peers_ask` wait saw. */
export interface AskWaitResult {
  readonly reply?: PeerMessage
  readonly progress: readonly PeerMessage[]
  /** Terminal state without a reply message (failed, expired, cancelled). */
  readonly state?: AskState
  readonly reason?: string
}

interface Pending {
  readonly progress: readonly PeerMessage[]
  readonly result?: AskWaitResult
  readonly signal: ChangeSignal
}

const NO_REPLY_STATES: ReadonlySet<string> = new Set(['failed', 'expired', 'cancelled'])

/** Inline waits for replies to asks this session sent (ARCHITECTURE §3.1 `peers_ask`). */
export class AskWaiters {
  private pending: ReadonlyMap<string, Pending> = new Map()

  watch(askId: string): void {
    this.pending = new Map(this.pending).set(askId, { progress: [], signal: new ChangeSignal() })
  }

  /** True when an inline wait is taking this ask's reply (so it is not injected later). */
  isWatching(askId: string): boolean {
    return this.pending.has(askId)
  }

  private update(askId: string, patch: (p: Pending) => Pending): boolean {
    const current = this.pending.get(askId)
    if (!current) return false
    const next = patch(current)
    this.pending = new Map(this.pending).set(askId, next)
    current.signal.notify()
    return true
  }

  /** Offers a reply/progress message; returns true when an inline wait consumed it. */
  offer(message: PeerMessage): boolean {
    const askId = message.re ?? undefined
    if (askId === undefined) return false
    if (message.kind === 'progress')
      return this.update(askId, (p) => ({ ...p, progress: [...p.progress, message] }))
    if (message.kind !== 'reply') return false
    return this.update(askId, (p) => ({ ...p, result: { reply: message, progress: p.progress } }))
  }

  /** `ask.updated`: a terminal state with no reply message ends the wait. */
  settle(askId: string, state: AskState, reason?: string): void {
    if (!NO_REPLY_STATES.has(state)) return
    this.update(askId, (p) =>
      p.result ? p : { ...p, result: { progress: p.progress, state, ...(reason ? { reason } : {}) } },
    )
  }

  /** Waits up to `ms`; always stops watching before it returns. */
  async result(clock: Clock, askId: string, ms: number, signal?: AbortSignal): Promise<AskWaitResult> {
    const deadline = clock.now() + ms
    try {
      for (;;) {
        const current = this.pending.get(askId)
        if (!current) return { progress: [] }
        if (current.result) return current.result
        const left = deadline - clock.now()
        if (left <= 0 || (await current.signal.wait(clock, left, signal)) !== 'changed')
          return this.pending.get(askId)?.result ?? { progress: this.pending.get(askId)?.progress ?? [] }
      }
    } finally {
      const map = new Map(this.pending)
      map.delete(askId)
      this.pending = map
    }
  }
}

/** Merges card patches and sends them at most once per debounce window (PROTOCOL §5.2: 300 ms). */
export class PatchDebouncer {
  private patch: SessionPatch = {}
  private timer: TimerHandle | undefined
  private inflight: Promise<void> = Promise.resolve()

  constructor(
    private readonly send: (patch: SessionPatch) => Promise<void>,
    private readonly clock: Clock,
    private readonly log: (line: string) => void,
    private readonly delayMs: number = ACTIVITY_DEBOUNCE_MS,
  ) {}

  push(patch: SessionPatch): void {
    this.patch = { ...this.patch, ...patch }
    if (this.timer !== undefined) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.delayMs)
  }

  /** Sends what is pending now. */
  flush(): Promise<void> {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    const patch = this.patch
    this.patch = {}
    if (Object.keys(patch).length === 0) return this.inflight
    this.inflight = this.inflight
      .then(() => this.send(patch))
      .catch((error: unknown) => this.log(`session.update failed: ${String(error)}`))
    return this.inflight
  }

  cancel(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.patch = {}
  }
}
