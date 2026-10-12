import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkQueueVersion,
  configCodexPath,
  findConfigPath,
  parseVersion,
  resolveCodexBinary,
  versionAtLeast,
} from '../../src/injectors/codex/binary'
import { bunRunner, type ProcessRunner } from '../../src/injectors/codex/process'
import { readArgvLog, writeFakeCodex } from './fake-codex'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apb-codex-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeConfig(codexHome: string, cliPath: string): Promise<void> {
  await mkdir(codexHome, { recursive: true })
  await writeFile(
    join(codexHome, 'config.toml'),
    `model = "gpt-6-codex"\n\n[mcp_servers.node_repl]\ncommand = "/x/node_repl"\n\n[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = "${cliPath}"\n`,
  )
}

describe('resolveCodexBinary', () => {
  it('prefers CODEX_CLI_PATH from the environment', async () => {
    const fake = await writeFakeCodex(join(dir, 'env'))
    const found = await resolveCodexBinary({
      env: { CODEX_CLI_PATH: fake.path, CODEX_HOME: join(dir, 'none') },
      prefer: 'cli',
      bundlePaths: [],
      userHome: dir,
    })
    expect(found).toEqual({ path: fake.path, source: 'env' })
  })

  it('reads CODEX_CLI_PATH from a nested table of $CODEX_HOME/config.toml', async () => {
    const fake = await writeFakeCodex(join(dir, 'cfg'))
    await writeConfig(join(dir, 'codex-home'), fake.path)
    const found = await resolveCodexBinary({
      env: { CODEX_HOME: join(dir, 'codex-home') },
      prefer: 'cli',
      bundlePaths: [],
      userHome: dir,
    })
    expect(found).toEqual({ path: fake.path, source: 'config' })
    expect(await configCodexPath({}, join(dir, 'nobody'))).toBeUndefined()
  })

  it('orders config, bundle and PATH by surface: desktop prefers the bundle', async () => {
    const cfg = await writeFakeCodex(join(dir, 'cfg'))
    const bundle = await writeFakeCodex(join(dir, 'bundle'))
    const onPath = await writeFakeCodex(join(dir, 'bin'))
    await writeConfig(join(dir, 'codex-home'), cfg.path)
    const base = {
      env: { CODEX_HOME: join(dir, 'codex-home'), PATH: join(dir, 'bin') },
      bundlePaths: [join(dir, 'missing', 'codex'), bundle.path],
      userHome: dir,
    }
    expect((await resolveCodexBinary({ ...base, prefer: 'cli' }))?.source).toBe('config')
    expect((await resolveCodexBinary({ ...base, prefer: 'desktop' }))?.path).toBe(bundle.path)
    const pathOnly = await resolveCodexBinary({
      ...base,
      prefer: 'cli',
      env: { PATH: join(dir, 'bin') },
      bundlePaths: [],
    })
    expect(pathOnly).toEqual({ path: onPath.path, source: 'path' })
  })

  it('skips non-executable candidates, a broken config and returns undefined when nothing is found', async () => {
    const plain = join(dir, 'plain-codex')
    await writeFile(plain, 'not executable')
    await mkdir(join(dir, 'codex-home'), { recursive: true })
    await writeFile(join(dir, 'codex-home', 'config.toml'), 'this is = = not toml [')
    const found = await resolveCodexBinary({
      env: { CODEX_CLI_PATH: plain, CODEX_HOME: join(dir, 'codex-home'), PATH: join(dir, 'empty') },
      prefer: 'cli',
      bundlePaths: [dir],
      userHome: dir,
    })
    expect(found).toBeUndefined()
  })

  it('finds the key in a table before descending into subtables', () => {
    expect(findConfigPath({ a: { CODEX_CLI_PATH: '/deep' }, CODEX_CLI_PATH: '/top' })).toBe('/top')
    expect(findConfigPath({ a: { b: { CODEX_CLI_PATH: '/deep' } } })).toBe('/deep')
    expect(findConfigPath({ CODEX_CLI_PATH: 42 })).toBeUndefined()
    expect(findConfigPath('text')).toBeUndefined()
  })
})

describe('versions', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('codex-cli 0.160.1')).toEqual([0, 160, 1])
    expect(parseVersion('codex')).toBeUndefined()
    expect(versionAtLeast([0, 157, 0], [0, 157, 0])).toBe(true)
    expect(versionAtLeast([0, 156, 9], [0, 157, 0])).toBe(false)
    expect(versionAtLeast([1, 0, 0], [0, 157, 0])).toBe(true)
  })

  it('checks the queue version through the runner', async () => {
    const binary = { path: '/fake/codex', source: 'env' as const }
    const say =
      (stdout: string, exitCode = 0): ProcessRunner =>
      async () => ({ exitCode, stdout, stderr: '', timedOut: false })
    expect(await checkQueueVersion(binary, say('codex-cli 0.160.1'), {})).toEqual({
      ok: true,
      version: '0.160.1',
    })
    const old = await checkQueueVersion(binary, say('codex-cli 0.150.0'), {})
    expect(old.ok).toBe(false)
    expect(old.reason).toContain('older than 0.157.0')
    expect((await checkQueueVersion(binary, say('', 1), {})).reason).toContain('gave no version')
  })
})

describe('bunRunner', () => {
  it('runs a command with a timeout and reports start failures', async () => {
    const fake = await writeFakeCodex(join(dir, 'bin'))
    const ok = await bunRunner([fake.path, 'queue', '--thread', 't'], {
      env: { FAKE_CODEX_LOG: fake.log },
      timeoutMs: 5000,
    })
    expect(ok).toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
    expect(await readArgvLog(fake.log)).toEqual([['queue', '--thread', 't']])
    const slow = await bunRunner([fake.path, 'queue'], {
      env: { FAKE_CODEX_SLEEP_MS: '3000' },
      timeoutMs: 100,
    })
    expect(slow.timedOut).toBe(true)
    expect(slow.exitCode).toBeNull()
    const missing = await bunRunner([join(dir, 'nope')], { env: {}, timeoutMs: 1000 })
    expect(missing.exitCode).toBeNull()
    expect(missing.stderr).toContain('cannot start')
  })
})
