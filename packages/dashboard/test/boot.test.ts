import { describe, expect, it } from 'bun:test'
import { configureZod } from '../src/boot'

describe('boot', () => {
  it('turns zod jitless on, keeping any config already there', () => {
    const target: { __zod_globalConfig?: Record<string, unknown> } = { __zod_globalConfig: { locale: 'x' } }
    configureZod(target)
    expect(target.__zod_globalConfig).toEqual({ locale: 'x', jitless: true })
  })

  it('creates the config when zod has not loaded yet', () => {
    const target: { __zod_globalConfig?: Record<string, unknown> } = {}
    configureZod(target)
    expect(target.__zod_globalConfig).toEqual({ jitless: true })
  })
})
