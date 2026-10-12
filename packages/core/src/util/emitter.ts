/** Minimal typed event emitter. Listener sets are replaced, never mutated, so emit is re-entrancy safe. */
export type Listener<T> = (payload: T) => void
export type Unsubscribe = () => void

export class Emitter<Events extends object> {
  private listeners: ReadonlyMap<keyof Events, ReadonlyArray<Listener<never>>> = new Map()
  private readonly onListenerError: (error: unknown) => void

  constructor(onListenerError: (error: unknown) => void = defaultListenerError) {
    this.onListenerError = onListenerError
  }

  on<K extends keyof Events>(name: K, listener: Listener<Events[K]>): Unsubscribe {
    const current = this.listeners.get(name) ?? []
    this.listeners = new Map(this.listeners).set(name, [...current, listener as Listener<never>])
    let active = true
    return () => {
      if (!active) return
      active = false
      const now = this.listeners.get(name) ?? []
      this.listeners = new Map(this.listeners).set(
        name,
        now.filter((l) => l !== listener),
      )
    }
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    const current = (this.listeners.get(name) ?? []) as ReadonlyArray<Listener<Events[K]>>
    for (const listener of current) {
      try {
        listener(payload)
      } catch (error) {
        this.onListenerError(error)
      }
    }
  }

  listenerCount<K extends keyof Events>(name: K): number {
    return this.listeners.get(name)?.length ?? 0
  }

  clear(): void {
    this.listeners = new Map()
  }
}

function defaultListenerError(error: unknown): void {
  console.error('[agent-peers/core] listener threw', error)
}
