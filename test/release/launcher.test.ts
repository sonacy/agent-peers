/**
 * The npm launcher (npm/cli): platform package resolution, and running it under Node and Bun from a
 * fake node_modules tree holding a fake platform binary that records its argv.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { chmod, cp, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import platform from '../../npm/cli/lib/platform.js'
import runner from '../../npm/cli/lib/run.js'
import { cleanupDirs, isolatedEnv, REPO_ROOT, runProcess, tempDir, writeExecutable } from './helpers'

afterAll(cleanupDirs)

const RECORDER = `#!/bin/sh
printf '%s\\n' "$@" > "$RECORD"
exit "\${EXIT_CODE:-0}"
`

/** <dir>/node_modules/@agent-peers/{cli, cli-<this platform>} with a recording binary. */
async function fakeInstall(withPlatformPackage = true): Promise<{ dir: string; launcher: string }> {
  const dir = await tempDir()
  const scope = join(dir, 'node_modules', '@agent-peers')
  await cp(join(REPO_ROOT, 'npm', 'cli'), join(scope, 'cli'), { recursive: true })
  const pkg = platform.packageName(process.platform, process.arch)
  if (withPlatformPackage && pkg !== undefined) {
    const pkgDir = join(dir, 'node_modules', pkg)
    await writeExecutable(join(pkgDir, 'bin', platform.binaryFile(process.platform)), RECORDER)
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0' }))
  }
  return { dir, launcher: join(scope, 'cli', 'bin', 'agent-peers.js') }
}

describe('platform package resolution', () => {
  it('names a package per supported platform and the binary file per OS', () => {
    expect(platform.packageName('darwin', 'arm64')).toBe('@agent-peers/cli-darwin-arm64')
    expect(platform.packageName('win32', 'x64')).toBe('@agent-peers/cli-win32-x64')
    expect(platform.packageName('linux', 'ia32')).toBeUndefined()
    expect(platform.binaryFile('win32')).toBe('agent-peers.exe')
    expect(platform.binaryFile('linux')).toBe('agent-peers')
    expect(platform.SUPPORTED).toHaveLength(5)
  })

  it('resolves <pkg>/bin/<binary> through the given resolver', () => {
    const asked: string[] = []
    const resolve = (id: string) => {
      asked.push(id)
      return `/nm/${id}`
    }
    expect(platform.resolveBinary({ platform: 'win32', arch: 'x64', resolve })).toBe(
      '/nm/@agent-peers/cli-win32-x64/bin/agent-peers.exe',
    )
    expect(asked).toEqual(['@agent-peers/cli-win32-x64/bin/agent-peers.exe'])
  })

  it('explains an unsupported platform and a missing optional dependency', () => {
    const resolve = () => {
      throw new Error('MODULE_NOT_FOUND')
    }
    expect(() => platform.resolveBinary({ platform: 'aix', arch: 'ppc64', resolve })).toThrow(
      'no prebuilt binary for aix-ppc64',
    )
    expect(() => platform.resolveBinary({ platform: 'linux', arch: 'arm64', resolve })).toThrow(
      'the platform package @agent-peers/cli-linux-arm64 is not installed',
    )
  })

  it('finds a real package through require.resolve from a node_modules tree', async () => {
    const { dir } = await fakeInstall()
    const resolve = createRequire(join(dir, 'node_modules', '@agent-peers', 'cli', 'bin', 'x.js')).resolve
    const found = platform.resolveBinary({ platform: process.platform, arch: process.arch, resolve })
    expect(found.endsWith(join('bin', platform.binaryFile(process.platform)))).toBe(true)
  })
})

describe('launcher process', () => {
  const runtimes = [
    ['bun', process.execPath],
    ['node', Bun.which('node')],
  ] as const

  for (const [name, runtime] of runtimes) {
    it.skipIf(runtime === null)(
      `execs the platform binary with argv and exit code under ${name}`,
      async () => {
        const { dir, launcher } = await fakeInstall()
        const record = join(dir, 'argv.txt')
        const env = isolatedEnv(dir, { RECORD: record, EXIT_CODE: '7' })
        const ran = await runProcess([runtime ?? '', launcher, 'join', 'https://h/j/X', '--here', 'a b'], env)
        expect(ran.stderr).toBe('')
        expect(ran.code).toBe(7)
        expect((await Bun.file(record).text()).split('\n')).toEqual([
          'join',
          'https://h/j/X',
          '--here',
          'a b',
          '',
        ])
      },
    )

    it.skipIf(runtime === null)(
      `fails with guidance when the platform package is missing (${name})`,
      async () => {
        const { dir, launcher } = await fakeInstall(false)
        const ran = await runProcess([runtime ?? '', launcher, 'who'], isolatedEnv(dir))
        expect(ran.code).toBe(1)
        expect(ran.stderr).toContain('is not installed')
      },
    )
  }
})

interface FakeTarget {
  readonly handlers: Map<string, () => void>
  readonly done: Promise<{ code?: number; signal?: string }>
  readonly target: Parameters<typeof runner.run>[2]
}

function fakeTarget(): FakeTarget {
  const handlers = new Map<string, () => void>()
  let finish: (value: { code?: number; signal?: string }) => void = () => undefined
  const done = new Promise<{ code?: number; signal?: string }>((resolve) => {
    finish = resolve
  })
  return {
    handlers,
    done,
    target: {
      exit: (code) => finish({ code }),
      kill: (signal) => finish({ signal }),
      on: (signal, handler) => handlers.set(signal, handler),
      off: (signal) => handlers.delete(signal),
    },
  }
}

describe('launcher run()', () => {
  it('mirrors the exit code and detaches its signal handlers', async () => {
    const dir = await tempDir()
    const bin = await writeExecutable(join(dir, 'bin'), '#!/bin/sh\nexit 3\n')
    const fake = fakeTarget()
    runner.run(bin, [], fake.target)
    expect([...fake.handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
    expect(await fake.done).toEqual({ code: 3 })
    expect(fake.handlers.size).toBe(0)
  })

  it('forwards SIGTERM to the binary and re-raises its signal; ignores SIGINT', async () => {
    const dir = await tempDir()
    const bin = await writeExecutable(join(dir, 'bin'), '#!/bin/sh\nexec sleep 30\n')
    const fake = fakeTarget()
    const child = runner.run(bin, [], fake.target)
    await new Promise((resolve) => child.once('spawn', resolve))
    fake.handlers.get('SIGINT')?.()
    expect(child.exitCode).toBeNull()
    fake.handlers.get('SIGTERM')?.()
    expect(await fake.done).toEqual({ signal: 'SIGTERM' })
  })

  it('reports a binary that cannot start', async () => {
    const fake = fakeTarget()
    const errors: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => errors.push(String(chunk)) > 0) as typeof process.stderr.write
    try {
      runner.run(join(await tempDir(), 'missing'), [], fake.target)
      expect(await fake.done).toEqual({ code: 1 })
    } finally {
      process.stderr.write = write
    }
    expect(errors.join('')).toContain('cannot run')
  })

  it('restores a lost executable bit (POSIX only)', async () => {
    const dir = await tempDir()
    const bin = await writeExecutable(join(dir, 'bin'), '#!/bin/sh\n')
    await chmod(bin, 0o644)
    runner.ensureExecutable(bin, 'win32')
    expect((await stat(bin)).mode & 0o777).toBe(0o644)
    runner.ensureExecutable(bin, 'linux')
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
    runner.ensureExecutable(bin, 'linux')
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
  })
})
