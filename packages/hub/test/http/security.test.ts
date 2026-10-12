import { afterEach, describe, expect, it } from 'bun:test'
import { isPeersError } from '@agent-peers/protocol'
import { MAX_BODY_BYTES, readLimited } from '../../src/http/errors'
import { forwardedFor } from '../../src/http/security'
import { errorCode, type HttpHub, startHttpHub } from './support'

let h: HttpHub | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

/** A body with no Content-Length, delivered in chunks (Transfer-Encoding: chunked). */
function chunked(totalBytes: number, chunkBytes = 16 * 1024): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(chunkBytes, totalBytes - sent)
      sent += size
      controller.enqueue(new Uint8Array(size).fill(0x61))
    },
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
  return 'ok'
}

describe('X-Forwarded-For behind a trusted proxy', () => {
  it('uses the rightmost entry, the one the proxy appended', () => {
    expect(forwardedFor('203.0.113.9')).toBe('203.0.113.9')
    expect(forwardedFor('1.2.3.4, 198.51.100.7, 203.0.113.9')).toBe('203.0.113.9')
    expect(forwardedFor('spoofed, 2001:db8::1')).toBe('2001:db8::1')
    expect(forwardedFor('1.2.3.4, ')).toBeUndefined()
    expect(forwardedFor('1.2.3.4, not-an-ip')).toBeUndefined()
    expect(forwardedFor(undefined)).toBeUndefined()
  })
})

describe('request body limits', () => {
  it('reads a body up to the limit and counts bytes, not UTF-16 units', async () => {
    const ok = new Request('http://x/', { method: 'POST', body: 'é'.repeat(100) })
    expect(await readLimited(ok, 200)).toBe('é'.repeat(100))
    const over = new Request('http://x/', { method: 'POST', body: 'é'.repeat(101) })
    expect(await codeOf(readLimited(over, 200))).toBe('payload_too_large')
    expect(await readLimited(new Request('http://x/'))).toBe('')
  })

  it('stops reading a chunked body with no Content-Length at the limit', async () => {
    const req = new Request('http://x/', { method: 'POST', body: chunked(10 * MAX_BODY_BYTES) })
    expect(req.headers.get('content-length')).toBeNull()
    expect(await codeOf(readLimited(req))).toBe('payload_too_large')
    const declared = new Request('http://x/', {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    })
    expect(await codeOf(readLimited(declared))).toBe('payload_too_large')
  })

  it('refuses an oversized chunked POST on the live listener', async () => {
    h = await startHttpHub()
    const post = (body: ReadableStream<Uint8Array>) =>
      fetch(`${h?.base}/v0/invites/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    expect(await errorCode(await post(chunked(10)))).toBe('parse_error')
    const big = await post(chunked(4 * MAX_BODY_BYTES))
    expect(big.status).toBe(413)
    expect(await errorCode(big)).toBe('payload_too_large')
    // The rest of the body was drained, so the keep-alive connection still serves requests.
    expect(await errorCode(await post(chunked(10)))).toBe('parse_error')
    const endless = await post(chunked(64 * MAX_BODY_BYTES))
    expect(endless.status).toBe(413)
  })
})
