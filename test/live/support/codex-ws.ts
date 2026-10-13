/**
 * `codex app-server proxy` pipes raw bytes to the daemon's control socket, which speaks WebSocket
 * (live-verified on 0.160.1: HTTP/1.1 101, then frames). This is the minimal client side of that:
 * the upgrade request, masked text frames out, and a decoder for the server's frames in.
 */
const MAX_FRAME_HEADER = 14

export function upgradeRequest(): string {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  return [
    'GET / HTTP/1.1',
    'Host: localhost',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n')
}

/** A masked client frame (RFC 6455 §5.2). */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length
  const extra = length < 126 ? 0 : length < 65_536 ? 2 : 8
  const frame = new Uint8Array(2 + extra + 4 + length)
  frame[0] = 0x80 | opcode
  if (extra === 0) frame[1] = 0x80 | length
  else if (extra === 2) {
    frame[1] = 0x80 | 126
    new DataView(frame.buffer).setUint16(2, length)
  } else {
    frame[1] = 0x80 | 127
    new DataView(frame.buffer).setBigUint64(2, BigInt(length))
  }
  const mask = crypto.getRandomValues(new Uint8Array(4))
  frame.set(mask, 2 + extra)
  const body = 2 + extra + 4
  for (let i = 0; i < length; i += 1) frame[body + i] = (payload[i] as number) ^ (mask[i % 4] as number)
  return frame
}

export const encodeText = (text: string): Uint8Array => encodeFrame(0x1, new TextEncoder().encode(text))

export interface Decoded {
  readonly messages: readonly string[]
  readonly pings: readonly Uint8Array[]
  readonly closed: boolean
}

interface Header {
  readonly fin: boolean
  readonly opcode: number
  readonly start: number
  readonly length: number
}

function readHeader(buf: Uint8Array): Header | undefined {
  if (buf.length < 2) return undefined
  const b0 = buf[0] as number
  const b1 = buf[1] as number
  let length = b1 & 0x7f
  let offset = 2
  const view = new DataView(buf.buffer, buf.byteOffset, Math.min(buf.length, MAX_FRAME_HEADER))
  if (length === 126) {
    if (buf.length < 4) return undefined
    length = view.getUint16(2)
    offset = 4
  } else if (length === 127) {
    if (buf.length < 10) return undefined
    length = Number(view.getBigUint64(2))
    offset = 10
  }
  if (b1 & 0x80) offset += 4 // a server must not mask, but skip a mask key if one is present
  return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, start: offset, length }
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** Stateful decoder: the HTTP 101 response first, then frames (text, continuation, ping, close). */
export class WsDecoder {
  private buf: Uint8Array = new Uint8Array(0)
  private upgraded = false
  private fragments: Uint8Array = new Uint8Array(0)
  private readonly decoder = new TextDecoder()

  /** True once the HTTP 101 arrived: frames written before it are lost, so callers wait for it. */
  get isUpgraded(): boolean {
    return this.upgraded
  }

  push(chunk: Uint8Array): Decoded {
    this.buf = concat(this.buf, chunk)
    if (!this.upgraded && !this.consumeUpgrade()) return { messages: [], pings: [], closed: false }
    const messages: string[] = []
    const pings: Uint8Array[] = []
    let closed = false
    for (;;) {
      const header = readHeader(this.buf)
      if (!header || this.buf.length < header.start + header.length) break
      const payload = this.buf.slice(header.start, header.start + header.length)
      this.buf = this.buf.slice(header.start + header.length)
      if (header.opcode === 0x9) pings.push(payload)
      else if (header.opcode === 0x8) closed = true
      else if (header.opcode === 0x1 || header.opcode === 0x0) {
        this.fragments = concat(this.fragments, payload)
        if (header.fin) {
          messages.push(this.decoder.decode(this.fragments))
          this.fragments = new Uint8Array(0)
        }
      }
    }
    return { messages, pings, closed }
  }

  private consumeUpgrade(): boolean {
    const text = this.decoder.decode(this.buf.slice(0, Math.min(this.buf.length, 4096)))
    const end = text.indexOf('\r\n\r\n')
    if (end < 0) return false
    if (!text.startsWith('HTTP/1.1 101')) throw new Error(`websocket upgrade refused: ${text.slice(0, 200)}`)
    this.buf = this.buf.slice(new TextEncoder().encode(text.slice(0, end + 4)).length)
    this.upgraded = true
    return true
  }
}
