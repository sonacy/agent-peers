/** Records every notification a real HubClient emits, and waits on them (no sleeps). */
import type { HubClient, NotificationMap, NotificationName } from '@agent-peers/core'
import { NOTIFICATION_NAMES } from '@agent-peers/core'

interface Note {
  readonly name: NotificationName
  readonly params: unknown
}

interface Waiter {
  readonly test: (note: Note) => boolean
  readonly resolve: (note: Note) => void
}

export const WAIT_MS = 3000

export class Inbox {
  private notes: readonly Note[] = []
  private waiters: readonly Waiter[] = []

  constructor(client: HubClient) {
    for (const name of NOTIFICATION_NAMES) client.on(name, (params) => this.push({ name, params }))
  }

  private push(note: Note): void {
    this.notes = [...this.notes, note]
    const ready = this.waiters.filter((w) => w.test(note))
    this.waiters = this.waiters.filter((w) => !ready.includes(w))
    for (const waiter of ready) waiter.resolve(note)
  }

  /** Every recorded notification of `name` matching `match`, oldest first. */
  all<N extends NotificationName>(
    name: N,
    match: (params: NotificationMap[N]) => boolean = () => true,
  ): readonly NotificationMap[N][] {
    return this.notes
      .filter((n) => n.name === name && match(n.params as NotificationMap[N]))
      .map((n) => n.params as NotificationMap[N])
  }

  /** Resolves with the first already-received or future matching notification. */
  waitFor<N extends NotificationName>(
    name: N,
    match: (params: NotificationMap[N]) => boolean = () => true,
    timeoutMs = WAIT_MS,
  ): Promise<NotificationMap[N]> {
    const test = (note: Note) => note.name === name && match(note.params as NotificationMap[N])
    const seen = this.notes.find(test)
    if (seen) return Promise.resolve(seen.params as NotificationMap[N])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(new Error(`timed out waiting for ${name}`))
      }, timeoutMs)
      const waiter: Waiter = {
        test,
        resolve: (note) => {
          clearTimeout(timer)
          resolve(note.params as NotificationMap[N])
        },
      }
      this.waiters = [...this.waiters, waiter]
    })
  }
}

/** Polls a condition the hub updates outside any notification (e.g. a socket close). */
export async function eventually(condition: () => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}
