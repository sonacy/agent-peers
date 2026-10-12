/** localStorage access that never throws (private mode, blocked storage): reads fall back. */

export function readStored(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/** Returns false when the value could not be saved; callers keep working with in-memory state. */
export function writeStored(key: string, value: string | undefined): boolean {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
    return true
  } catch {
    return false
  }
}
