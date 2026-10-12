/** Polling helpers: e2e steps cross real processes, so assertions wait for the state to converge. */

export interface EventuallyOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_INTERVAL_MS = 50

/**
 * Re-runs `probe` until it returns a value other than undefined/false, then returns that value.
 * Fails with `what` and the last error when the deadline passes.
 */
export async function eventually<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  options: EventuallyOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let lastError: unknown
  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined && value !== false) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      const detail = lastError === undefined ? '' : `: ${String(lastError)}`
      throw new Error(`timed out waiting for ${what}${detail}`)
    }
    await Bun.sleep(options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
}

/** Rejects when `promise` does not settle within `ms`. */
export async function within<T>(what: string, promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
