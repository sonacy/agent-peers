import { describe, expect, it } from 'bun:test'
import {
  CLIENT_ERROR_CODES,
  fromRpcError,
  httpStatusFor,
  isErrorCode,
  isPeersError,
  isProtocolErrorCode,
  isWireErrorCode,
  JSON_RPC,
  PeersError,
  PROTOCOL_ERROR_CODES,
  rpcCodeFor,
  toPeersError,
  toRpcError,
} from '../src/index'

describe('error codes', () => {
  it('lists every §6.5 code', () => {
    for (const code of [
      'rename_conflict',
      'invalid_name',
      'invite_closed',
      'already_member',
      'knock_pending',
      'adapter_outdated',
      'unknown_session',
      'ask_taken',
      'rate_limited',
      'payload_too_large',
    ])
      expect(isProtocolErrorCode(code)).toBe(true)
    expect(PROTOCOL_ERROR_CODES).toHaveLength(21)
    expect(isProtocolErrorCode('timeout')).toBe(false)
    expect(isProtocolErrorCode(1)).toBe(false)
    expect(isWireErrorCode('invalid_params')).toBe(true)
    expect(isWireErrorCode('timeout')).toBe(false)
    expect(isWireErrorCode(null)).toBe(false)
    expect(CLIENT_ERROR_CODES.every(isErrorCode)).toBe(true)
    expect(isErrorCode('nope')).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
  })
})

describe('PeersError', () => {
  it('keeps data without the code and reads retry_after_ms', () => {
    const error = new PeersError('rate_limited', 'slow down', { code: 'x', retry_after_ms: 500 })
    expect(error.name).toBe('PeersError')
    expect(error.data).toEqual({ retry_after_ms: 500 })
    expect(Object.isFrozen(error.data)).toBe(true)
    expect(error.retryAfterMs).toBe(500)
    const bare = new PeersError('forbidden')
    expect(bare.message).toBe('forbidden')
    expect(bare.data).toBeUndefined()
    expect(bare.retryAfterMs).toBeUndefined()
    expect(isPeersError(bare)).toBe(true)
    expect(isPeersError(bare, 'forbidden')).toBe(true)
    expect(isPeersError(bare, 'internal')).toBe(false)
    expect(isPeersError(new Error('x'))).toBe(false)
  })

  it('wraps unknown errors', () => {
    const same = new PeersError('timeout')
    expect(toPeersError(same)).toBe(same)
    const wrapped = toPeersError(new Error('boom'))
    expect(wrapped).toMatchObject({ code: 'internal', message: 'boom' })
    expect(wrapped.cause).toBeInstanceOf(Error)
    expect(toPeersError('text', 'invalid_result')).toMatchObject({ code: 'invalid_result', message: 'text' })
    expect(toPeersError(new Error(''))).toMatchObject({ message: 'internal' })
  })
})

describe('JSON-RPC mapping', () => {
  it('encodes protocol errors in the server range with data.code', () => {
    expect(toRpcError(new PeersError('handle_taken', 'taken', { suggested: 'work-2' }))).toEqual({
      code: JSON_RPC.APPLICATION_ERROR,
      message: 'taken',
      data: { suggested: 'work-2', code: 'handle_taken' },
    })
    expect(toRpcError(new PeersError('invalid_params', 'bad')).code).toBe(-32602)
    expect(toRpcError(new PeersError('method_not_found', 'x')).code).toBe(-32601)
    expect(toRpcError(new PeersError('internal', 'x')).code).toBe(-32603)
    expect(rpcCodeFor('parse_error')).toBe(-32700)
    expect(rpcCodeFor('invalid_request')).toBe(-32600)
  })

  it('never leaks non-protocol errors', () => {
    expect(toRpcError(new Error('db password wrong'))).toEqual({
      code: -32603,
      message: 'internal error',
      data: { code: 'internal' },
    })
    expect(toRpcError(new PeersError('timeout', 'client side')).data).toEqual({ code: 'internal' })
    expect(toRpcError(new PeersError('forbidden', 'x'.repeat(5000))).message).toHaveLength(1024)
  })

  it('decodes data.code first, then the numeric code', () => {
    expect(fromRpcError({ code: -32000, message: 'm', data: { code: 'ask_taken' } }).code).toBe('ask_taken')
    expect(fromRpcError({ code: -32000, message: '', data: { code: 'made_up' } })).toMatchObject({
      code: 'internal',
      message: 'internal',
    })
    expect(fromRpcError({ code: -32700, message: 'p', data: ['x'] }).code).toBe('parse_error')
    expect(fromRpcError({ code: -32601, message: 'p' }).code).toBe('method_not_found')
    expect(fromRpcError({ code: -32602, message: 'p' }).code).toBe('invalid_params')
    expect(fromRpcError({ code: -32600, message: 'p', data: null }).code).toBe('invalid_request')
    const limited = fromRpcError({
      code: -32000,
      message: 'm',
      data: { code: 'rate_limited', retry_after_ms: 9 },
    })
    expect(limited.retryAfterMs).toBe(9)
  })

  it('round-trips every wire code', () => {
    for (const code of PROTOCOL_ERROR_CODES) {
      expect(fromRpcError(toRpcError(new PeersError(code, 'm'))).code).toBe(code)
    }
  })

  it('maps codes to HTTP statuses for the member API', () => {
    expect(httpStatusFor('unauthorized')).toBe(401)
    expect(httpStatusFor('forbidden')).toBe(403)
    expect(httpStatusFor('room_not_found')).toBe(404)
    expect(httpStatusFor('invite_closed')).toBe(410)
    expect(httpStatusFor('handle_taken')).toBe(409)
    expect(httpStatusFor('invalid_name')).toBe(400)
    expect(httpStatusFor('payload_too_large')).toBe(413)
    expect(httpStatusFor('rate_limited')).toBe(429)
    expect(httpStatusFor('internal')).toBe(500)
    expect(httpStatusFor('timeout')).toBe(500)
  })
})
