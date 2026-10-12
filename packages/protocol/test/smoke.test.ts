import { describe, expect, it } from 'bun:test'
import { PACKAGE_NAME } from '../src/index'

describe('protocol', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agent-peers/protocol')
  })
})
