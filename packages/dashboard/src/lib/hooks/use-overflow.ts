import { type RefObject, useEffect, useState } from 'react'

/** True when the element's content is cut off (an ellipsis or a line clamp is showing). */
export function isOverflowing(
  el: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollHeight' | 'clientHeight'>,
): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
}

/** Watches whether `ref`'s text is clipped by CSS; re-checks on resize and when `text` changes. */
export function useOverflow(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [clipped, setClipped] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: new text can clip without a resize, so it re-measures
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const check = (): void => setClipped(isOverflowing(el))
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, text])
  return clipped
}
