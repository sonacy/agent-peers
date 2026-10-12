/** `SHA256SUMS` in `sha256sum` format (`<hex>  <name>`), which install.sh and `sha256sum -c` read. */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const SUMS_FILE = 'SHA256SUMS'

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await readFile(path))
  return hasher.digest('hex')
}

export interface Checksum {
  readonly name: string
  readonly sha256: string
}

/** Sorted by name, one line each, trailing newline. */
export function renderSums(sums: readonly Checksum[]): string {
  const sorted = [...sums].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sorted.map((sum) => `${sum.sha256}  ${sum.name}\n`).join('')
}

/** Parses `SHA256SUMS` (also the `*name` binary-mode spelling); malformed lines are an error. */
export function parseSums(text: string): readonly Checksum[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
      if (match?.[1] === undefined || match[2] === undefined) throw new Error(`bad SHA256SUMS line: ${line}`)
      return { sha256: match[1], name: match[2] }
    })
}

/** Hashes `files` and writes `<dir>/SHA256SUMS`; returns the checksums written. */
export async function writeSums(dir: string, files: readonly string[]): Promise<readonly Checksum[]> {
  const sums = await Promise.all(
    files.map(async (file) => ({ name: basename(file), sha256: await sha256File(file) })),
  )
  await Bun.write(join(dir, SUMS_FILE), renderSums(sums))
  return sums
}
