import { describe, expect, it } from 'bun:test'
import { PACKAGE_NAME } from '../src/index'

describe('cli', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agent-peers/cli')
  })
})
