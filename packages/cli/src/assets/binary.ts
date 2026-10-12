/**
 * The installed binary (ARCHITECTURE §9, ONBOARDING §3 step 3): the running single-file binary is
 * copied to `<home>/bin/agent-peers-<version>`, and `<home>/bin/current` points at it.
 */
import { chmod, copyFile, lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvLike } from '@agent-peers/core'

export const CURRENT_LINK = 'current'
/** Dev builds: `AGENT_PEERS_BINARY=packages/cli/dist/agent-peers bun src/bin.ts add`. */
export const BINARY_ENV = 'AGENT_PEERS_BINARY'

export interface BinaryPaths {
  readonly dir: string
  readonly versioned: string
  readonly current: string
}

export function binaryPaths(home: string, version: string): BinaryPaths {
  const dir = join(home, 'bin')
  return { dir, versioned: join(dir, `agent-peers-${version}`), current: join(dir, CURRENT_LINK) }
}

/** True inside a `bun build --compile` executable (its modules live under /$bunfs/). */
export function isCompiledBinary(main: string = Bun.main): boolean {
  return main.startsWith('/$bunfs/') || /^[A-Z]:\\~BUN\\/.test(main)
}

/**
 * The binary to install: `$AGENT_PEERS_BINARY`, else the running executable when compiled. Running
 * from source (`bun src/bin.ts`) has no binary to copy, so this is undefined.
 */
export function sourceBinary(env: EnvLike, compiled: boolean = isCompiledBinary()): string | undefined {
  const explicit = env[BINARY_ENV]?.trim()
  if (explicit) return explicit
  return compiled ? process.execPath : undefined
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const left = Bun.file(a)
  const right = Bun.file(b)
  if (!(await right.exists()) || left.size !== right.size) return false
  const [x, y] = await Promise.all([left.bytes(), right.bytes()])
  return Buffer.from(x).equals(Buffer.from(y))
}

async function pointCurrent(paths: BinaryPaths, target: string): Promise<boolean> {
  const existing = await lstat(paths.current).catch(() => undefined)
  if (existing?.isSymbolicLink() && (await readlink(paths.current)) === target) return false
  const tmp = join(paths.dir, `.${CURRENT_LINK}.${process.pid}.tmp`)
  await rm(tmp, { force: true })
  await symlink(target, tmp)
  await rename(tmp, paths.current)
  return true
}

export interface InstalledBinary extends BinaryPaths {
  /** False when the same binary was already in place (nothing copied, link unchanged). */
  readonly changed: boolean
}

/** Copies `source` into `<home>/bin` (atomic rename) and points `current` at it. Idempotent. */
export async function installBinary(source: string, home: string, version: string): Promise<InstalledBinary> {
  const paths = binaryPaths(home, version)
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  let copied = false
  if (!(await sameFile(source, paths.versioned))) {
    const tmp = `${paths.versioned}.${process.pid}.tmp`
    await copyFile(source, tmp)
    await chmod(tmp, 0o755)
    await rename(tmp, paths.versioned)
    copied = true
  }
  const linked = await pointCurrent(paths, `agent-peers-${version}`)
  return { ...paths, changed: copied || linked }
}

/** Removes `<home>/bin` (every installed version and the `current` link). */
export async function removeBinaries(home: string): Promise<void> {
  await rm(join(home, 'bin'), { recursive: true, force: true })
}
