import { useEffect, useState } from 'react'

/** 找房间 waits this long after the last keystroke before searching (DASHBOARD §4.2). */
export const SEARCH_DEBOUNCE_MS = 300

/** `value`, but only after it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}
