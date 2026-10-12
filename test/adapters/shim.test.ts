/** Runs the real POSIX shim against a fake agent-peers binary in a temp HOME. Never touches ~/.agent-peers. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ADAPTERS_DIR, makeTempDir, removeDir } from './helpers'

const SHIMS = ['claude-code', 'codex'].map((tree) => join(ADAPTERS_DIR, tree, 'bin/agent-peers'))

/** Prints its pid, arguments and stdin so the test can see what the shim exec'd. */
const FAKE_BINARY = `#!/bin/sh
printf 'pid=%s\\n' "$$"
for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done
printf 'stdin=%s\\n' "$(cat)"
`

let home = ''
let fakeBin = ''

beforeAll(async () => {
  home = await makeTempDir('shim-home')
  const binDir = join(home, '.agent-peers', 'bin')
  await mkdir(binDir, { recursive: true })
  fakeBin = join(binDir, 'current')
  await writeFile(fakeBin, FAKE_BINARY)
  await chmod(fakeBin, 0o755)
})

afterAll(async () => {
  await removeDir(home)
})

const run = (shim: string, args: readonly string[], env: Record<string, string>, stdin = '') => {
  const proc = Bun.spawnSync(['/bin/sh', '-c', 'exec "$@"', 'sh', shim, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: home, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: proc.exitCode, pid: proc.pid, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

describe.each(SHIMS)('shim %s', (shim) => {
  it('execs the installed binary with every argument and stdin', () => {
    const result = run(
      shim,
      ['hook', 'stop', '--agent', 'claude-code', 'with space'],
      {},
      '{"session_id":"s"}',
    )
    expect(result.code).toBe(0)
    expect(result.out).toContain('arg=hook\narg=stop\narg=--agent\narg=claude-code\narg=with space\n')
    expect(result.out).toContain('stdin={"session_id":"s"}')
    // exec, not spawn: the binary keeps the shim's pid, so ancestor-PID discovery still finds the agent.
    expect(result.out).toContain(`pid=${result.pid}\n`)
  })

  it('honours AGENT_PEERS_BIN, then AGENT_PEERS_HOME', async () => {
    const other = await makeTempDir('shim-alt')
    try {
      await mkdir(join(other, 'bin'), { recursive: true })
      await writeFile(join(other, 'bin', 'current'), '#!/bin/sh\necho from-home "$@"\n')
      await chmod(join(other, 'bin', 'current'), 0o755)
      expect(run(shim, ['mcp'], { AGENT_PEERS_HOME: other }).out).toBe('from-home mcp\n')
      expect(run(shim, ['mcp'], { AGENT_PEERS_HOME: other, AGENT_PEERS_BIN: fakeBin }).out).toContain(
        'arg=mcp',
      )
    } finally {
      await removeDir(other)
    }
  })

  it('no-ops every hook under Cursor without running the binary', () => {
    const result = run(shim, ['hook', 'pre-tool-use', '--agent', 'claude-code'], { CURSOR_VERSION: '3.20.0' })
    expect(result).toMatchObject({ code: 0, out: '{}\n', err: '' })
  })

  it('still runs non-hook commands under Cursor', () => {
    const result = run(shim, ['mcp', '--surface', 'claude-code'], { CURSOR_VERSION: '3.20.0' })
    expect(result.out).toContain('arg=mcp')
  })

  it('fails with exit 1 (never 2, which would block) when the binary is missing', () => {
    const result = run(shim, ['hook', 'stop'], { AGENT_PEERS_BIN: join(home, 'missing') })
    expect(result.code).toBe(1)
    expect(result.err).toContain('binary not found or not executable')
    expect(result.out).toBe('')
  })
})
