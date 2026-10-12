/** Reduced motion (DASHBOARD §9): the OS setting plus an in-app switch saved in localStorage. */
import { MotionConfig, useReducedMotion } from 'motion/react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { readStored, writeStored } from './storage'

export const REDUCE_MOTION_KEY = 'peers.reduce-motion'

interface MotionPreference {
  /** The in-app switch (avatar menu → 减少动态效果). */
  readonly appReduced: boolean
  /** The switch or the OS setting: what components should honor. */
  readonly reduced: boolean
  readonly setAppReduced: (value: boolean) => void
}

const MotionPreferenceContext = createContext<MotionPreference | undefined>(undefined)

export function MotionPreferenceProvider({ children }: { readonly children: ReactNode }) {
  const [appReduced, setState] = useState(() => readStored(REDUCE_MOTION_KEY) === 'true')
  const systemReduced = useReducedMotion() ?? false
  const setAppReduced = useCallback((value: boolean) => {
    setState(value)
    writeStored(REDUCE_MOTION_KEY, value ? 'true' : undefined)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = appReduced ? 'true' : 'false'
  }, [appReduced])
  const value = useMemo(
    () => ({ appReduced, reduced: appReduced || systemReduced, setAppReduced }),
    [appReduced, systemReduced, setAppReduced],
  )
  return (
    <MotionPreferenceContext.Provider value={value}>
      <MotionConfig reducedMotion={appReduced ? 'always' : 'user'}>{children}</MotionConfig>
    </MotionPreferenceContext.Provider>
  )
}

const FALLBACK: MotionPreference = { appReduced: false, reduced: false, setAppReduced: () => {} }

export function useMotionPreference(): MotionPreference {
  const fromContext = useContext(MotionPreferenceContext)
  const systemReduced = useReducedMotion() ?? false
  return fromContext ?? { ...FALLBACK, reduced: systemReduced }
}
