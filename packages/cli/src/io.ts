/** Process I/O behind an interface, so commands run in-process under test. */
import type { EnvLike } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'

export interface CliIo {
  readonly env: EnvLike
  /** Whole stdin as text ('' when it is a terminal). */
  readStdin(): Promise<string>
  stdout(text: string): void
  stderr(text: string): void
}

/** Hook stdin is a single JSON object; anything bigger is not a hook payload. */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024
/** Agents write hook stdin and close it at once; never hang on an open pipe. */
export const STDIN_TIMEOUT_MS = 5000

/** Reads a byte stream to text with a size cap and a deadline. */
export async function readStream(
  stream: ReadableStream<Uint8Array>,
  options: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_STDIN_BYTES
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const timer = setTimeout(() => void reader.cancel(), options.timeoutMs ?? STDIN_TIMEOUT_MS)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new PeersError('payload_too_large', `stdin exceeds ${maxBytes} bytes`)
      chunks.push(value)
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const processIo: CliIo = {
  env: process.env,
  readStdin: () => (process.stdin.isTTY ? Promise.resolve('') : readStream(Bun.stdin.stream())),
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}
