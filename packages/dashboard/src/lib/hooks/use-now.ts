import { useEffect, useState } from 'react'

/** The current time, re-read every `intervalMs` so relative times stay fresh. */
export function useNow(intervalMs: number = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
