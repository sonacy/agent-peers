import type { ControlContext, ControlHandler, Injected } from '../../src/control/ops'
import type { ProcessEntry, ProcessTree } from '../../src/control/process-tree'

/** A process tree from a pid → parent map. Every listed pid (and `alive`) is alive. */
export function fakeTree(
  parents: Readonly<Record<number, number | ProcessEntry>>,
  alive: readonly number[] = [],
): ProcessTree & { readonly lookups: number[] } {
  const lookups: number[] = []
  const live = new Set([...Object.keys(parents).map(Number), ...alive])
  return {
    lookups,
    async lookup(pid) {
      lookups.push(pid)
      const entry = parents[pid]
      if (entry === undefined) return undefined
      return typeof entry === 'number' ? { ppid: entry } : entry
    },
    isAlive: (pid) => live.has(pid),
  }
}

/** Resolves when `signal` aborts. */
export const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A handler with harmless defaults; override per test. */
export function fakeHandler(overrides: Partial<ControlHandler> = {}): ControlHandler & {
  readonly undeliveredLog: Array<{ localKey: string; injected: Injected }>
} {
  const undeliveredLog: Array<{ localKey: string; injected: Injected }> = []
  return {
    undeliveredLog,
    register: async () => ({ context: 'hello' }),
    activity: async () => ({}),
    take: async () => null,
    wait: async (_p, ctx: ControlContext) => {
      await aborted(ctx.signal)
      return null
    },
    turn_end: async () => ({}),
    end: async () => ({}),
    gate: async () => ({ decision: 'allow', reason: 'ok' }),
    permission: async () => ({}),
    autojoin: async () => ({ accepted: false }),
    undelivered: (localKey, injected) => {
      undeliveredLog.push({ localKey, injected })
    },
    ...overrides,
  }
}
