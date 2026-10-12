/**
 * A fake `codex` executable for injector tests. It never talks to a real Codex: `--version` prints
 * FAKE_CODEX_VERSION, every other call appends its argv as a JSON line to FAKE_CODEX_LOG, then sleeps
 * FAKE_CODEX_SLEEP_MS and exits with FAKE_CODEX_EXIT.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SCRIPT = `
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('codex-cli ' + (process.env.FAKE_CODEX_VERSION || '0.160.1') + '\\n')
  process.exit(0)
}
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n')
const sleep = Number(process.env.FAKE_CODEX_SLEEP_MS || 0)
if (sleep > 0) Bun.sleepSync(sleep)
const code = Number(process.env.FAKE_CODEX_EXIT || 0)
if (code !== 0) process.stderr.write('fake codex failure\\n')
process.exit(code)
`

/** Writes `<dir>/codex` (executable) and returns its path and the argv log path. */
export async function writeFakeCodex(dir: string, name = 'codex'): Promise<{ path: string; log: string }> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, `#!${process.execPath}\n${SCRIPT}`)
  await chmod(path, 0o755)
  return { path, log: join(dir, `${name}.argv.log`) }
}

export async function readArgvLog(log: string): Promise<readonly (readonly string[])[]> {
  const text = await readFile(log, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[])
}
