import { describe, expect, it } from 'bun:test'
import {
  charCount,
  compareVersions,
  createInviteCode,
  createUlidFactory,
  INVITE_CODE_RE,
  isAdapterOutdated,
  isAgentKind,
  isInviteCode,
  isUlid,
  isValidName,
  maskInviteCode,
  NAME_RE,
  negotiateProtocol,
  nextFreeName,
  normalizeNewlines,
  PACKAGE_NAME,
  PROTOCOL_VERSION,
  parseProtocol,
  sanitizeLine,
  suffixName,
  toNameSlug,
  truncateChars,
  truncateUnits,
  ULID_RE,
  ulid,
  ulidTime,
  utf8ByteLength,
} from '../src/index'

const ch = (code: number) => String.fromCodePoint(code)

describe('constants', () => {
  it('names the protocol', () => {
    expect(PACKAGE_NAME).toBe('@agent-peers/protocol')
    expect(PROTOCOL_VERSION).toBe('agent-peers/0.3')
    expect(isAgentKind('codex')).toBe(true)
    expect(isAgentKind('gemini')).toBe(false)
  })
})

describe('names', () => {
  it('validates names', () => {
    for (const ok of ['a', 'gulei', 'api-server', 'a_b', '9lives', 'x'.repeat(32)])
      expect(isValidName(ok)).toBe(true)
    for (const bad of ['', '-a', '_a', 'A', 'a b', 'x'.repeat(33), '调研', 'a.b'])
      expect(isValidName(bad)).toBe(false)
    expect(isValidName(5)).toBe(false)
    expect(NAME_RE.source).toBe('^[a-z0-9][a-z0-9_-]{0,31}$')
  })

  it('slugs free text, with a deterministic fallback for CJK', () => {
    expect(toNameSlug('Payments Team')).toBe('payments-team')
    expect(toNameSlug('Café  Crème!!')).toBe('cafe-creme')
    expect(toNameSlug('--Hello__')).toBe('hello')
    expect(toNameSlug('调研 T3Code 项目')).toBe('t3code')
    const cjk = toNameSlug('支付联调')
    expect(cjk).toMatch(/^room-[0-9a-z]+$/)
    expect(isValidName(cjk)).toBe(true)
    expect(toNameSlug('支付联调')).toBe(cjk)
    expect(toNameSlug('支付联调二')).not.toBe(cjk)
    expect(toNameSlug('支付', 'My Handle')).toMatch(/^my-handle-/)
    expect(toNameSlug('支付', '你好')).toMatch(/^x-/)
    expect(toNameSlug('a'.repeat(40))).toHaveLength(32)
  })

  it('suffixes names within the length limit', () => {
    expect(suffixName('alice', 2)).toBe('alice-2')
    expect(suffixName('x'.repeat(32), 12)).toBe(`${'x'.repeat(29)}-12`)
    expect(suffixName(`${'x'.repeat(30)}-y`, 2)).toBe(`${'x'.repeat(30)}-2`)
    expect(suffixName('a-', 3)).toBe('a-3')
    expect(() => suffixName('Bad', 2)).toThrow(expect.objectContaining({ code: 'invalid_name' }))
    expect(() => suffixName('ok', 0)).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(() => suffixName('ok', 1.5)).toThrow()
  })

  it('finds the next free name', () => {
    const taken = new Set(['work', 'work-2'])
    expect(nextFreeName('work', (n) => taken.has(n))).toBe('work-3')
    expect(nextFreeName('home', (n) => taken.has(n))).toBe('home')
    expect(() => nextFreeName('Bad Name', () => false)).toThrow(
      expect.objectContaining({ code: 'invalid_name' }),
    )
    expect(() => nextFreeName('w', () => true, 3)).toThrow(expect.objectContaining({ code: 'handle_taken' }))
  })
})

describe('ids', () => {
  it('generates sortable ULIDs', () => {
    const a = ulid(1_000)
    const b = ulid(2_000)
    expect(a).toMatch(ULID_RE)
    expect(a < b).toBe(true)
    expect(ulidTime(b)).toBe(2_000)
    expect(ulid()).not.toBe(ulid())
    expect(isUlid(a)).toBe(true)
    expect(isUlid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false)
    expect(isUlid(1)).toBe(false)
    const next = createUlidFactory()
    const ids = [next(5), next(5), next(5)]
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(3)
  })

  it('creates and masks invite codes', () => {
    const code = createInviteCode()
    expect(code).toMatch(INVITE_CODE_RE)
    expect(isInviteCode(code)).toBe(true)
    expect(isInviteCode('7K3QX9TZ4M2BHC8')).toBe(false)
    expect(isInviteCode('7K3QX9TZ4M2BHC8I')).toBe(false)
    expect(isInviteCode(null)).toBe(false)
    expect(createInviteCode()).not.toBe(code)
    expect(maskInviteCode('7K3QX9TZ4M2B7H58')).toBe('inv_••••••••7H58')
  })
})

describe('text', () => {
  it('counts UTF-8 bytes like TextEncoder', () => {
    const encoder = new TextEncoder()
    const lone = String.fromCharCode(0xd800)
    for (const s of ['', 'abc', 'é', '界', '😀', `a${lone}b`, `${lone}`, 'x😀y界'])
      expect(utf8ByteLength(s)).toBe(encoder.encode(s).byteLength)
  })

  it('sanitizes one line', () => {
    expect(sanitizeLine('  hello\r\n\tworld  ')).toBe('hello world')
    expect(sanitizeLine(`a${ch(0x2028)}b${ch(0x85)}c`)).toBe('a b c')
    expect(sanitizeLine(`ab${ch(0x202e)}cd${ch(0x200b)}e${ch(0xfeff)}`)).toBe('abcde')
    expect(sanitizeLine(`x${ch(0)}y${ch(0x7f)}z`)).toBe('x y z')
    expect(sanitizeLine('x'.repeat(100))).toBe(`${'x'.repeat(79)}…`)
    expect(charCount(sanitizeLine('调'.repeat(100), 40))).toBe(40)
    expect(sanitizeLine('é')).toBe('é')
  })

  it('truncates by characters and code units', () => {
    expect(truncateChars('abc', 3)).toBe('abc')
    expect(truncateChars('abcd', 3)).toBe('ab…')
    expect(truncateChars('abc', 0)).toBe('')
    expect(truncateChars('😀😀😀', 2)).toBe('😀…')
    expect(truncateUnits('abc', 5)).toBe('abc')
    expect(truncateUnits('a😀', 2)).toBe('a')
    expect(truncateUnits('abc', 0)).toBe('')
    expect(charCount('a😀')).toBe(2)
    expect(normalizeNewlines(`a\r\nb\rc${ch(0x2029)}d`)).toBe('a\nb\nc\nd')
  })
})

describe('versions', () => {
  it('compares and negotiates', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('0.2', '0.2.0')).toBe(0)
    expect(compareVersions('1.0.0-beta', '1.0.1')).toBe(-1)
    expect(isAdapterOutdated('0.1.9', '0.2.0')).toBe(true)
    expect(isAdapterOutdated('0.2.0', '0.2.0')).toBe(false)
    expect(isAdapterOutdated('0.1.0', undefined)).toBe(false)
    expect(parseProtocol('agent-peers/0.3')).toEqual({ major: 0, minor: 3 })
    expect(parseProtocol('agent-peers/x')).toBeUndefined()
    expect(parseProtocol('other/0.3')).toBeUndefined()
    expect(negotiateProtocol(['agent-peers/0.4', 'agent-peers/0.3'])).toBe('agent-peers/0.3')
    expect(negotiateProtocol(['agent-peers/0.4'])).toBeUndefined()
  })
})
