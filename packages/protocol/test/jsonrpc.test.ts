import { describe, expect, it } from 'bun:test'
import {
  assertFrameSize,
  decodeFrame,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  frameFits,
  MAX_FRAME_BYTES,
  PeersError,
} from '../src/index'

const invalidCode = (data: unknown, max?: number) => {
  const frame = decodeFrame(data, max)
  return frame.type === 'invalid' ? frame.error.code : `not invalid: ${frame.type}`
}

describe('decodeFrame', () => {
  it('classifies the four message shapes', () => {
    expect(decodeFrame(encodeRequest(3, 'ping', {}))).toEqual({
      type: 'request',
      id: 3,
      method: 'ping',
      params: {},
    })
    expect(decodeFrame(encodeRequest('a', 'ping', undefined))).toEqual({
      type: 'request',
      id: 'a',
      method: 'ping',
      params: undefined,
    })
    expect(decodeFrame(encodeNotification('kicked', { a: 1 }))).toEqual({
      type: 'notification',
      method: 'kicked',
      params: { a: 1 },
    })
    expect(decodeFrame(encodeResult(1, null))).toEqual({ type: 'result', id: 1, result: null })
    expect(decodeFrame('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"bad"}}')).toEqual({
      type: 'error',
      id: null,
      error: { code: -32700, message: 'bad' },
    })
  })

  it('rejects frame errors with protocol codes', () => {
    expect(invalidCode(new Uint8Array())).toBe('invalid_request')
    expect(invalidCode('{nope')).toBe('parse_error')
    expect(invalidCode('[{"jsonrpc":"2.0","method":"ping"}]')).toBe('invalid_request')
    expect(invalidCode('{"x":1}')).toBe('invalid_request')
    expect(invalidCode('"just a string"')).toBe('invalid_request')
    expect(invalidCode('{"jsonrpc":"1.0","id":1,"method":"ping"}')).toBe('invalid_request')
    expect(invalidCode('{"jsonrpc":"2.0","id":{},"method":"ping"}')).toBe('invalid_request')
    expect(invalidCode('x'.repeat(MAX_FRAME_BYTES + 1))).toBe('payload_too_large')
    expect(invalidCode(JSON.stringify({ jsonrpc: '2.0', method: 'm', params: '界'.repeat(40) }), 100)).toBe(
      'payload_too_large',
    )
  })

  it('keeps the id of a malformed request so the hub can answer it', () => {
    const frame = decodeFrame('{"jsonrpc":"2.0","id":7,"method":""}')
    expect(frame).toMatchObject({ type: 'invalid', id: 7 })
    expect(decodeFrame('{"jsonrpc":"2.0","id":7,"result":1,"error":{"code":1}}')).toMatchObject({
      type: 'invalid',
      id: 7,
    })
  })
})

describe('encoding', () => {
  it('enforces the frame limit by UTF-8 bytes', () => {
    expect(frameFits('abc', 3)).toBe(true)
    expect(frameFits('界', 2)).toBe(false)
    expect(frameFits('界', 3)).toBe(true)
    expect(frameFits('abcd', 3)).toBe(false)
    expect(assertFrameSize('ok')).toBe('ok')
    expect(() => encodeRequest(1, 'msg.send', { text: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(PeersError)
    expect(() => encodeNotification('m', { t: 'x'.repeat(200) }, 100)).toThrow(/payload|limit/)
    try {
      encodeResult(1, 'x'.repeat(200), 100)
    } catch (error) {
      expect(error).toMatchObject({ code: 'payload_too_large' })
    }
  })

  it('encodes error responses', () => {
    expect(JSON.parse(encodeError(4, new PeersError('forbidden', 'no')))).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32000, message: 'no', data: { code: 'forbidden' } },
    })
    expect(JSON.parse(encodeError(null, new Error('secret'))).error.message).toBe('internal error')
  })
})
