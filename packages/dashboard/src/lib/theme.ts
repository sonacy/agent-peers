/** Theme choice: follow the system, or force light/dark through `<html data-theme>` (DASHBOARD §3). */
import { useCallback, useEffect, useState } from 'react'
import { readStored, writeStored } from './storage'

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]
export const THEME_KEY = 'peers.theme'

export function parseTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

export function useTheme(): readonly [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => parseTheme(readStored(THEME_KEY)))
  useEffect(() => applyTheme(theme), [theme])
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    writeStored(THEME_KEY, next === 'system' ? undefined : next)
  }, [])
  return [theme, setTheme] as const
}
