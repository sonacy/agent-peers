/** JSON-lines framing for the control socket: UTF-8-safe line splitting with a length cap. */

export type LineEvent = { readonly line: string } | { readonly overflow: true }

/** Splits a byte stream into lines. A line longer than `maxBytes` yields one `overflow` and stops. */
export class LineReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private buffer = ''
  private overflowed = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): readonly LineEvent[] {
    if (this.overflowed) return []
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const events: LineEvent[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > this.maxBytes) return this.overflow(events)
      if (line.trim() !== '') events.push({ line })
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxBytes) return this.overflow(events)
    return events
  }

  private overflow(events: LineEvent[]): readonly LineEvent[] {
    this.overflowed = true
    this.buffer = ''
    return [...events, { overflow: true }]
  }
}

interface WritableSocket {
  write(data: Uint8Array): number
  end(): void
}

/** Queues bytes the kernel didn't accept yet and flushes them on `drain`. */
export class LineWriter {
  private pending: Uint8Array = new Uint8Array(0)
  private endAfterFlush = false
  private readonly encoder = new TextEncoder()

  constructor(private readonly socket: WritableSocket) {}

  writeLine(text: string): void {
    const bytes = this.encoder.encode(`${text}\n`)
    if (this.pending.length > 0) {
      this.pending = concat(this.pending, bytes)
      return
    }
    const written = this.socket.write(bytes)
    if (written < bytes.length) this.pending = bytes.subarray(Math.max(0, written))
  }

  /** Called from the socket's `drain` handler. */
  drain(): void {
    if (this.pending.length > 0) {
      const written = this.socket.write(this.pending)
      this.pending = this.pending.subarray(Math.max(0, written))
    }
    if (this.pending.length === 0 && this.endAfterFlush) this.socket.end()
  }

  /** Ends the socket once everything queued is written. */
  end(): void {
    this.endAfterFlush = true
    if (this.pending.length === 0) this.socket.end()
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
