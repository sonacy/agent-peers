import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { FONT_SOURCES, registerFonts } from '../../src/lib/fonts'
import { useDelayedFlag } from '../../src/lib/hooks/use-delayed-flag'
import { useMediaQuery } from '../../src/lib/hooks/use-media-query'
import { useNow } from '../../src/lib/hooks/use-now'
import {
  MotionPreferenceProvider,
  REDUCE_MOTION_KEY,
  useMotionPreference,
} from '../../src/lib/motion-preference'
import { readStored, writeStored } from '../../src/lib/storage'
import { applyTheme, parseTheme, THEME_KEY, useTheme } from '../../src/lib/theme'
import { act, setupUi, waitFor } from '../helpers/render'

setupUi()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('storage', () => {
  it('reads and writes localStorage', () => {
    expect(writeStored('k', 'v')).toBe(true)
    expect(readStored('k')).toBe('v')
    expect(writeStored('k', undefined)).toBe(true)
    expect(readStored('k')).toBeUndefined()
  })
  it('survives a throwing storage', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })
    try {
      expect(readStored('k')).toBeUndefined()
      expect(writeStored('k', 'v')).toBe(false)
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
    }
  })
})

describe('theme', () => {
  it('parses stored values', () => {
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('weird')).toBe('system')
    expect(parseTheme(undefined)).toBe('system')
  })
  it('applies and clears data-theme', () => {
    const el = document.createElement('div')
    applyTheme('dark', el)
    expect(el.dataset.theme).toBe('dark')
    applyTheme('system', el)
    expect(el.dataset.theme).toBeUndefined()
  })
  it('persists the choice through useTheme', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('system')
    act(() => result.current[1]('dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(readStored(THEME_KEY)).toBe('dark')
    act(() => result.current[1]('system'))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(readStored(THEME_KEY)).toBeUndefined()
  })
})

describe('useDelayedFlag', () => {
  it('turns on only after the delay and resets when inactive', async () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 30), {
      initialProps: { active: true },
    })
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
    rerender({ active: false })
    expect(result.current).toBe(false)
  })
  it('shows immediately with no delay', () => {
    const { result } = renderHook(() => useDelayedFlag(true, 0))
    expect(result.current).toBe(true)
  })
  it('never shows a fast load', async () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 50), {
      initialProps: { active: true },
    })
    rerender({ active: false })
    await sleep(70)
    expect(result.current).toBe(false)
  })
})

describe('useNow / useMediaQuery', () => {
  it('ticks', async () => {
    const { result } = renderHook(() => useNow(10))
    const first = result.current
    await waitFor(() => expect(result.current).toBeGreaterThan(first))
  })
  it('reads a media query', () => {
    const { result } = renderHook(() => useMediaQuery('(min-width: 1px)'))
    expect(typeof result.current).toBe('boolean')
  })
})

describe('motion preference', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MotionPreferenceProvider>{children}</MotionPreferenceProvider>
  )
  it('toggles the in-app switch, the root flag and storage', () => {
    const { result } = renderHook(() => useMotionPreference(), { wrapper })
    expect(result.current.appReduced).toBe(false)
    act(() => result.current.setAppReduced(true))
    expect(result.current.reduced).toBe(true)
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
    expect(readStored(REDUCE_MOTION_KEY)).toBe('true')
    act(() => result.current.setAppReduced(false))
    expect(readStored(REDUCE_MOTION_KEY)).toBeUndefined()
  })
  it('falls back outside the provider', () => {
    const { result } = renderHook(() => useMotionPreference())
    expect(result.current.appReduced).toBe(false)
    result.current.setAppReduced(true)
    expect(result.current.appReduced).toBe(false)
  })
})

describe('registerFonts', () => {
  it('adds every self-hosted face', () => {
    const added: unknown[] = []
    const fonts = { add: (face: unknown) => added.push(face) } as unknown as FontFaceSet
    const hadFontFace = 'FontFace' in globalThis
    if (!hadFontFace) {
      Object.defineProperty(globalThis, 'FontFace', {
        configurable: true,
        value: class {
          constructor(
            readonly family: string,
            readonly source: string,
          ) {}
        },
      })
    }
    try {
      expect(registerFonts(fonts)).toBe(FONT_SOURCES.length)
      expect(added).toHaveLength(FONT_SOURCES.length)
      expect(FONT_SOURCES.every((f) => f.url.endsWith('.woff2'))).toBe(true)
    } finally {
      if (!hadFontFace) Reflect.deleteProperty(globalThis, 'FontFace')
    }
  })
  it('does nothing without a font set', () => {
    expect(registerFonts(undefined)).toBe(0)
  })
})
