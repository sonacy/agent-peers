import { useEffect, useState } from 'react'

/** Phone layout breakpoint (DASHBOARD §9): under 640px. */
export const PHONE_QUERY = '(max-width: 639px)'

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (): void => setValue(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return value
}
