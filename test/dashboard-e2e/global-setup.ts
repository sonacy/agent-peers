/**
 * Starts the fixture server (Bun) once per run and hands its control URL to the workers through the
 * environment. The returned function stops it (and every hub it still holds).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { CONTROL_ENV } from './fixture/contract'

const SERVER = join(import.meta.dirname, 'fixture', 'server.ts')
/** The fixture server builds the SPA before it listens. */
const READY_TIMEOUT_MS = 120_000

function waitForControlUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    if (child.stdout === null) return reject(new Error('fixture server has no stdout'))
    const lines = createInterface({ input: child.stdout })
    const timer = setTimeout(
      () => reject(new Error('fixture server did not start in time')),
      READY_TIMEOUT_MS,
    )
    lines.once('line', (line) => {
      clearTimeout(timer)
      try {
        resolve((JSON.parse(line) as { control: string }).control)
      } catch {
        reject(new Error(`fixture server said: ${line}`))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture server exited early (code ${code})`))
    })
  })
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const child = spawn(process.env.BUN_BIN ?? 'bun', [SERVER], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    process.env[CONTROL_ENV] = await waitForControlUrl(child)
  } catch (error) {
    await stopChild(child)
    throw error
  }
  return () => stopChild(child)
}
