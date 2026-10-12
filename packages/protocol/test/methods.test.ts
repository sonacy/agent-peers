import { describe, expect, it } from 'bun:test'
import {
  isMethodName,
  METHOD_NAMES,
  METHODS,
  type MethodName,
  ONE_WAY_METHODS,
  type ParamsOf,
  PeersError,
  paramsError,
  parseParams,
  parseRequest,
  parseResult,
  roomIdOf,
} from '../src/index'
import { AID, CODE, card, METHOD_CASES, RID, SID } from './fixtures'

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return error instanceof PeersError ? error.code : 'not-a-peers-error'
  }
}

describe('method map', () => {
  it('covers every request method in §6.4 and §10', () => {
    expect([...METHOD_NAMES].sort() as string[]).toEqual(Object.keys(METHOD_CASES).sort())
    expect(METHOD_NAMES).toHaveLength(33)
    expect(ONE_WAY_METHODS.has('bye')).toBe(true)
    expect(isMethodName('room.join')).toBe(true)
    expect(isMethodName('toString')).toBe(false)
    expect(isMethodName(42)).toBe(false)
  })

  for (const name of Object.keys(METHOD_CASES)) {
    const method = name as MethodName
    const cases = METHOD_CASES[name]
    it(`${name}: accepts valid params, rejects invalid ones, validates results`, () => {
      expect(cases).toBeDefined()
      if (!cases) return
      expect(() => parseParams(method, cases.valid)).not.toThrow()
      expect(codeOf(() => parseParams(method, cases.invalid))).toMatch(/^invalid_(params|name)$/)
      expect(() => parseResult(method, cases.result)).not.toThrow()
      expect(codeOf(() => parseResult(method, 'garbage'))).toBe('invalid_result')
      expect(METHODS[method].params).toBeDefined()
    })
  }
})

describe('params details', () => {
  it('room.join takes exactly one of room_id, room_name, invite_code', () => {
    const join = (extra: Record<string, unknown>) => () =>
      parseParams('room.join', { session_id: SID, ...extra })
    expect(join({ room_id: RID })).not.toThrow()
    expect(join({ invite_code: CODE, takeover: true })).not.toThrow()
    expect(codeOf(join({}))).toBe('invalid_params')
    expect(codeOf(join({ room_id: RID, room_name: 'x' }))).toBe('invalid_params')
    expect(codeOf(join({ room_name: 'Not Valid' }))).toBe('invalid_name')
    expect(codeOf(join({ room_id: RID, handle: '-bad' }))).toBe('invalid_name')
  })

  it('maps oversize text to payload_too_large and an ask to several handles to invalid_params', () => {
    const base = { session_id: SID, client_msg_id: AID, room_id: RID, kind: 'chat' }
    expect(codeOf(() => parseParams('msg.send', { ...base, text: 'x'.repeat(64 * 1024 + 1) }))).toBe(
      'payload_too_large',
    )
    expect(() => parseParams('msg.send', { ...base, text: 'é'.repeat(32 * 1024) })).not.toThrow()
    expect(codeOf(() => parseParams('msg.send', { ...base, text: 'é'.repeat(32 * 1024 + 1) }))).toBe(
      'payload_too_large',
    )
    expect(codeOf(() => parseParams('msg.send', { ...base, kind: 'ask', text: 'q' }))).toBe('invalid_params')
    expect(codeOf(() => parseParams('msg.send', { ...base, ttl_ms: 25 * 3600_000, text: 'q' }))).toBe(
      'invalid_params',
    )
  })

  it('caps serialized meta at 8 KiB with payload_too_large', () => {
    const base = { session_id: SID, client_msg_id: AID, room_id: RID, kind: 'chat', text: 'hi' }
    expect(() => parseParams('msg.send', { ...base, meta: { note: 'x'.repeat(8000) } })).not.toThrow()
    expect(codeOf(() => parseParams('msg.send', { ...base, meta: { note: 'x'.repeat(8 * 1024) } }))).toBe(
      'payload_too_large',
    )
    const reply = { session_id: SID, client_msg_id: AID, ask_id: AID, text: 'a', state: 'answered' }
    expect(codeOf(() => parseParams('msg.reply', { ...reply, meta: { n: 'é'.repeat(4096) } }))).toBe(
      'payload_too_large',
    )
    expect(codeOf(() => parseParams('msg.reply', { ...reply, meta: { n: 1n } }))).toBe('payload_too_large')
  })

  it('sanitizes free text on parse and drops unknown fields', () => {
    const parsed = parseParams('session.open', {
      local_key: 'k',
      card: {
        agent: { kind: 'some-future-agent' },
        host: '  mbp\n',
        title: '调研 T3Code 项目，并且写一份很长很长很长很长很长很长很长很长很长很长的报告',
        summary: 'line one\nline two',
        extra: 'ignored',
      },
    })
    expect(parsed.card.agent.kind).toBe('other')
    expect(parsed.card.host).toBe('mbp')
    expect(Array.from(parsed.card.title ?? '')).toHaveLength(40)
    expect(parsed.card.summary).toBe('line one line two')
    expect('extra' in parsed.card).toBe(false)
    const knock = parseParams('room.knock', { session_id: SID, room_id: RID, note: 'n'.repeat(300) })
    expect(knock.note).toHaveLength(120)
  })

  it('refuses absolute paths in workspace fields', () => {
    const open = (workspace: Record<string, string>) => () =>
      parseParams('session.open', { local_key: 'k', card: { agent: { kind: 'pi' }, host: 'h', workspace } })
    expect(open({ name: 'payments-api', git_remote: 'github.com/acme/x' })).not.toThrow()
    expect(codeOf(open({ name: '/Users/me/src/payments-api' }))).toBe('invalid_params')
    expect(codeOf(open({ name: 'src/payments-api' }))).toBe('invalid_params')
    expect(codeOf(open({ git_remote: 'C:\\repo' }))).toBe('invalid_params')
    expect(codeOf(open({ branch: '~/x' }))).toBe('invalid_params')
  })

  it('session.rename needs a title or handle, and room_id only with a handle', () => {
    expect(() => parseParams('session.rename', { session_id: SID, title: 'x' })).not.toThrow()
    expect(codeOf(() => parseParams('session.rename', { session_id: SID, title: 'x', room_id: RID }))).toBe(
      'invalid_params',
    )
  })

  it('treats missing params as {} and reports unknown methods', () => {
    expect(parseParams('ping', undefined)).toEqual({})
    expect(codeOf(() => parseRequest('nope', {}))).toBe('method_not_found')
    expect(parseRequest('ping', {})).toEqual({})
  })

  it('carries the zod issues on the error', () => {
    try {
      parseParams('msg.ack', { session_id: SID, room_id: RID, seq: 'x' })
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PeersError)
      const peers = error as PeersError
      expect(peers.message).toContain('seq')
      expect(peers.data?.issues).toEqual([{ path: 'seq', message: expect.any(String) }])
    }
  })

  it('reports root-level issues', () => {
    const error = paramsError(METHODS.ping.params.safeParse('x').error ?? expect.unreachable(), 'ctx')
    expect(error.message).toStartWith('ctx: (root)')
  })

  it('types params for callers', () => {
    const params: ParamsOf<'msg.send'> = {
      session_id: SID,
      client_msg_id: AID,
      room_id: RID,
      kind: 'chat',
      text: 'hi',
      to: ['bob'] as readonly string[],
    }
    expect(parseParams('msg.send', params).to).toEqual(['bob'])
  })
})

describe('results', () => {
  it('fills card defaults and resolves room ids', () => {
    const { members } = parseResult('peers.list', {
      members: [{ room_id: RID, handle: 'work', card: { ...card, outdated: undefined, rooms: undefined } }],
    })
    expect(members[0]?.card.outdated).toBe(false)
    expect(members[0]?.card.rooms).toEqual([])
    const opened = parseResult('session.open', {
      session_id: SID,
      rooms: [
        { room: { room_id: RID, name: 'x' }, handle: 'a' },
        { room: 'R2', handle: 'b' },
        { handle: 'c' },
      ],
    })
    expect(opened.rooms.map(roomIdOf)).toEqual([RID, 'R2', undefined])
    expect(roomIdOf({ room_id: 'R9', room: 'R2' })).toBe('R9')
  })

  it('rejects malformed cards', () => {
    expect(
      codeOf(() => parseResult('peers.list', { members: [{ room_id: RID, handle: 'w', card: {} }] })),
    ).toBe('invalid_result')
  })
})
