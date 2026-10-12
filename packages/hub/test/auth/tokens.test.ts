import { describe, expect, it } from 'bun:test'
import { isInviteCode } from '@agent-peers/protocol'
import {
  bearerToken,
  constantTimeEqual,
  deriveInviteCode,
  generateInviteCode,
  generateLoginCode,
  generateSecret,
  generateToken,
  hmacSha256,
  normalizeInviteCode,
  sha256Hex,
} from '../../src/auth/tokens'

describe('auth tokens', () => {
  it('generates prefixed 256-bit tokens that never repeat', () => {
    const a = generateToken('member')
    const b = generateToken('member')
    expect(a.startsWith('apm_')).toBe(true)
    expect(generateToken('admin').startsWith('apa_')).toBe(true)
    expect(generateToken('web').startsWith('apw_')).toBe(true)
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(40)
  })

  it('hashes with sha256 hex and HMAC', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hmacSha256('k', 'v')).toHaveLength(32)
  })

  it('compares in constant time', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })

  it('makes 16-char base32 invite codes, random or derived', () => {
    const code = generateInviteCode()
    expect(isInviteCode(code)).toBe(true)
    const derived = deriveInviteCode('secret', 'invite-1')
    expect(isInviteCode(derived)).toBe(true)
    expect(deriveInviteCode('secret', 'invite-1')).toBe(derived)
    expect(deriveInviteCode('other', 'invite-1')).not.toBe(derived)
  })

  it('normalizes typed invite codes', () => {
    expect(normalizeInviteCode(' abco-il ')).toBe('ABC0-11')
  })

  it('makes login codes and secrets', () => {
    expect(generateLoginCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/)
    expect(generateSecret().length).toBeGreaterThan(30)
  })

  it('parses bearer headers', () => {
    expect(bearerToken('Bearer apm_abcdefgh')).toBe('apm_abcdefgh')
    expect(bearerToken('bearer  apm_abcdefgh ')).toBe('apm_abcdefgh')
    expect(bearerToken('Basic xyz')).toBeUndefined()
    expect(bearerToken(null)).toBeUndefined()
    expect(bearerToken('Bearer short')).toBeUndefined()
  })
})
