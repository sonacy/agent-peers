import { useEffect, useState } from 'react'

/** Loading skeletons appear only after this long, so fast loads never flash (DASHBOARD §5). */
export const SKELETON_DELAY_MS = 300

/** True once `active` has stayed true for `delayMs`; resets as soon as it turns false. */
export function useDelayedFlag(active: boolean, delayMs: number = SKELETON_DELAY_MS): boolean {
  const [shown, setShown] = useState(active && delayMs <= 0)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    if (delayMs <= 0) {
      setShown(true)
      return
    }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return shown
}
