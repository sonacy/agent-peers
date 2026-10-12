import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.js'

describe('core', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agent-peers/core')
  })
})
