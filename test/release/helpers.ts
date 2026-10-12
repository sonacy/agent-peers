/**
 * Shared fixtures for the release tests: temp dirs, the current-platform binary (built once per
 * test run and reused), and a fake GitHub Releases server.
 */
import { rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRelease, type ReleaseResult } from '../../packages/cli/scripts/release/build'
import { renderSums } from '../../packages/cli/scripts/release/checksums'
import { currentTarget } from '../../packages/cli/scripts/release/targets'

export const REPO_ROOT = join(import.meta.dir, '..', '..')

const dirs: string[] = []

export async function tempDir(prefix = 'agent-peers-release-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export async function cleanupDirs(): Promise<void> {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
}

export async function writeExecutable(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  await chmod(path, 0o755)
  return path
}

let built: Promise<{ readonly dir: string; readonly result: ReleaseResult }> | undefined

/**
 * The current platform's release binary, compiled once per `bun test` process into a temp dir
 * (no dashboard: its package belongs to another build step; adapters must already be embedded).
 */
export function currentBinary(): Promise<{ readonly dir: string; readonly result: ReleaseResult }> {
  built ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-peers-binary-'))
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    const result = await buildRelease({
      repoRoot: REPO_ROOT,
      outDir: dir,
      targets: [currentTarget()],
      dashboard: 'skip',
      adapters: 'check',
      minify: true,
      sourcemap: true,
    })
    return { dir, result }
  })()
  return built
}

/** `sha256sum`-style hash of bytes. */
export function sha256(bytes: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}

export interface FakeRelease {
  readonly url: string
  readonly requests: string[]
  stop(): Promise<void>
}

/** Serves `files` (name → bytes) at `/<name>`, like a release's download dir; 404 otherwise. */
export function fakeReleaseServer(files: ReadonlyMap<string, string | Uint8Array>): FakeRelease {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1))
      requests.push(name)
      const body = files.get(name)
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(typeof body === 'string' ? body : body.slice())
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
}

/** install.sh's asset name for this machine. */
export function installAssetName(): string {
  const target = currentTarget()
  return `agent-peers-${target.os}-${target.arch}`
}

export const sumsFor = (files: ReadonlyMap<string, string | Uint8Array>): string =>
  renderSums([...files].map(([name, bytes]) => ({ name, sha256: sha256(bytes) })))

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export async function runProcess(
  argv: readonly string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<Ran> {
  const proc = Bun.spawn([...argv], { env, cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** PATH plus nothing else from the real environment (no proxies, no real HOME). */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...extra }
}
