import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { plistValue, readVersion } from '../src/agents/binaries'
import { claudeDesktopConfigDir } from '../src/agents/claude'
import { findCodexCliPath } from '../src/agents/codex'
import { detectCurrentAgent } from '../src/agents/current'
import { detectAll } from '../src/agents/registry'
import { createSys, defaultAppDirs } from '../src/agents/sys'
import { atLeast, compareVersions, parseVersion } from '../src/agents/version'
import {
  FAKE_CLAUDE,
  type FakeMachine,
  fakeMachine,
  infoPlist,
  installFakeClaude,
  installFakeClaudeDesktop,
  installFakeCodex,
  installFakeCodexApp,
} from './helpers/fake-agents'

let m: FakeMachine

beforeEach(async () => {
  m = await fakeMachine()
})
afterEach(async () => {
  await m.cleanup()
})

const byId = async () => Object.fromEntries((await detectAll(m.sys())).map((d) => [d.id, d]))

describe('versions', () => {
  it('parses --version outputs', () => {
    expect(parseVersion('2.1.296 (Claude Code)')).toBe('2.1.296')
    expect(parseVersion('codex-cli 0.163.0-alpha.5')).toBe('0.163.0-alpha.5')
    expect(parseVersion('no version')).toBeUndefined()
  })

  it('compares numerically with prereleases before releases', () => {
    expect(compareVersions('0.157.0', '0.160.1')).toBe(-1)
    expect(compareVersions('2.1.300', '2.1.296')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0-a', '1.0.0-b')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('x', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', 'x')).toBe(1)
    expect(compareVersions('x', 'y')).toBe(0)
    expect(atLeast('0.163.0-alpha.5', '0.157.0')).toBe(true)
    expect(atLeast(undefined, '0.157.0')).toBe(false)
  })
})

describe('detection', () => {
  it('finds nothing on an empty machine', async () => {
    const all = await byId()
    expect(Object.values(all).map((d) => [d.id, d.detected, d.supported])).toEqual([
      ['claude-code', false, false],
      ['claude-desktop', false, false],
      ['codex', false, false],
      ['codex-desktop', false, false],
    ])
  })

  it('detects every v0 agent from PATH, app bundles and config dirs', async () => {
    await installFakeClaude(m)
    await installFakeCodex(m)
    await installFakeCodexApp(m)
    await installFakeClaudeDesktop(m)
    const all = await byId()
    expect(all['claude-code']).toMatchObject({ supported: true, version: '2.1.296' })
    expect(all.codex).toMatchObject({ supported: true, version: '0.160.1' })
    expect(all['codex-desktop']).toMatchObject({
      supported: true,
      version: '26.930.61225',
      engineVersion: '0.160.1',
    })
    expect(all['codex-desktop']?.binary?.path).toContain('ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
    expect(all['claude-desktop']).toMatchObject({ supported: true, version: '2.31226.1' })
    expect(all['claude-code']?.configDir).toBe(join(m.home, '.claude'))
  })

  it('skips a cmux wrapper shim and resolves the real claude behind it', async () => {
    const shimDir = join(m.root, '.cmuxterm', 'cmux-cli-shims', '1')
    await mkdir(shimDir, { recursive: true })
    await writeFile(join(shimDir, 'claude'), '#!/bin/sh\nexec cmux-claude-wrapper "$@"\n')
    await chmod(join(shimDir, 'claude'), 0o755)
    const realDir = join(m.root, 'real')
    await installFakeClaude(m, realDir)
    m.env = { ...m.env, PATH: `${shimDir}:${realDir}:/usr/bin:/bin` }
    const claude = (await byId())['claude-code']
    expect(claude?.binary?.path).toBe(join(realDir, 'claude'))
    expect(claude?.evidence.some((line) => line.includes('wrapper shim'))).toBe(true)
  })

  it('also recognizes a small script that hands off to cmux anywhere on PATH', async () => {
    await writeFile(join(m.binDir, 'codex'), '#!/bin/sh\nexec cmux codex "$@"\n')
    await chmod(join(m.binDir, 'codex'), 0o755)
    const codex = (await byId()).codex
    expect(codex).toMatchObject({ detected: true, supported: false, reason: 'codex CLI not found on PATH' })
  })

  it('prefers the running binary (CLAUDE_CODE_EXECPATH) and the native versions dir', async () => {
    const versions = join(m.home, '.local', 'share', 'claude', 'versions')
    await installFakeClaude(m, join(versions, 'tmp'))
    await mkdir(versions, { recursive: true })
    await symlink(join(versions, 'tmp', 'claude'), join(versions, '2.1.296'))
    expect((await byId())['claude-code']?.binary?.source).toBe('versions dir')
    m.env = { ...m.env, CLAUDE_CODE_EXECPATH: join(versions, 'tmp', 'claude') }
    expect((await byId())['claude-code']?.binary?.source).toBe('CLAUDE_CODE_EXECPATH')
  })

  it('greys out agents that are too old', async () => {
    await installFakeClaude(m)
    await installFakeCodex(m)
    m.env = { ...m.env, FAKE_CLAUDE_VERSION: '2.1.100', FAKE_CODEX_VERSION: '0.150.0' }
    const all = await byId()
    expect(all['claude-code']?.reason).toBe('Claude Code 2.1.100 is too old (needs 2.1.229+)')
    expect(all.codex?.supported).toBe(false)
    expect(all.codex?.reason).toContain('0.150.0 is too old')
  })

  it('falls back to the skills dir when only the Claude config dir exists', async () => {
    m.env = { ...m.env, CLAUDE_CONFIG_DIR: join(m.root, 'claude-config') }
    await mkdir(join(m.root, 'claude-config'))
    const claude = (await byId())['claude-code']
    expect(claude).toMatchObject({
      detected: true,
      supported: true,
      configDir: join(m.root, 'claude-config'),
    })
    expect(claude?.notes[0]).toContain('skills-dir')
  })

  it('finds the Codex desktop engine through CODEX_CLI_PATH in config.toml', async () => {
    const engine = join(m.root, 'Some.app', 'Contents', 'MacOS', 'codex')
    await installFakeCodex(m, dirname(engine))
    await mkdir(join(m.home, '.codex'), { recursive: true })
    const toml = `[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = "${engine}"\n`
    await writeFile(join(m.home, '.codex', 'config.toml'), toml)
    const desktop = (await byId())['codex-desktop']
    expect(desktop).toMatchObject({ detected: true, supported: true, engineVersion: '0.160.1' })
    expect(desktop?.binary?.source).toBe('config.toml CODEX_CLI_PATH')
  })

  it('reports a desktop app whose engine is missing or old', async () => {
    const app = await installFakeCodexApp(m)
    m.env = { ...m.env, FAKE_CODEX_VERSION: '0.149.0' }
    expect((await byId())['codex-desktop']?.reason).toContain('engine 0.149.0 is too old')
    await writeFile(join(app, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), '')
    expect((await byId())['codex-desktop']?.reason).toBe('the bundled Codex engine was not found')
  })

  it('honors CODEX_HOME and ignores other bundle ids', async () => {
    await mkdir(join(m.appsDir, 'ChatGPT.app', 'Contents'), { recursive: true })
    await writeFile(
      join(m.appsDir, 'ChatGPT.app', 'Contents', 'Info.plist'),
      infoPlist('com.openai.chat', '1.0'),
    )
    m.env = { ...m.env, CODEX_HOME: '~/custom-codex' }
    const desktop = (await byId())['codex-desktop']
    expect(desktop?.detected).toBe(false)
    expect(desktop?.configDir).toBe(join(m.home, 'custom-codex'))
  })
})

describe('helpers', () => {
  it('looks for app bundles in /Applications unless AGENT_PEERS_APP_DIRS says otherwise', () => {
    expect(defaultAppDirs({}, '/h', 'darwin')).toEqual(['/Applications', '/h/Applications'])
    expect(defaultAppDirs({}, '/h', 'linux')).toEqual([])
    expect(defaultAppDirs({ AGENT_PEERS_APP_DIRS: '/a:/b' }, '/h', 'darwin')).toEqual(['/a', '/b'])
    expect(createSys({ env: { HOME: '/x' } }).home).toBe('/x')
  })

  it('finds CODEX_CLI_PATH at any depth', () => {
    expect(findCodexCliPath({ a: { b: { CODEX_CLI_PATH: '/x/codex' } } })).toBe('/x/codex')
    expect(findCodexCliPath({ a: 1 })).toBeUndefined()
  })

  it('places the Claude Desktop config per platform', () => {
    const at = (platform: NodeJS.Platform, env: Record<string, string> = {}) =>
      claudeDesktopConfigDir(createSys({ env, home: '/h', platform, appDirs: [] }))
    expect(at('darwin')).toBe('/h/Library/Application Support/Claude')
    expect(at('win32', { APPDATA: 'C:/Roaming' })).toBe(join('C:/Roaming', 'Claude'))
    expect(at('linux')).toBe('/h/.config/Claude')
    expect(at('linux', { XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/Claude')
  })

  it('reads plist values and ignores binary plists off macOS', async () => {
    const plist = join(m.root, 'Info.plist')
    await writeFile(plist, infoPlist('a.b', '1.2'))
    const sys = m.sys()
    expect(await plistValue(sys, plist, 'CFBundleIdentifier')).toBe('a.b')
    expect(await plistValue(sys, plist, 'Missing')).toBeUndefined()
    await writeFile(plist, 'bplist00')
    const linux = createSys({ env: m.env, home: m.home, platform: 'linux', appDirs: [] })
    expect(await plistValue(linux, plist, 'CFBundleIdentifier')).toBeUndefined()
    expect(await plistValue(sys, join(m.root, 'none.plist'), 'X')).toBeUndefined()
  })

  it('treats a failing or silent --version as no version', async () => {
    const bad = join(m.root, 'bad')
    await writeFile(bad, '#!/bin/sh\nexit 3\n')
    await chmod(bad, 0o755)
    expect(await readVersion(m.sys(), bad)).toBeUndefined()
    expect(await readVersion(m.sys(), join(m.root, 'missing'))).toBeUndefined()
  })

  it('kills a hung child at the deadline', async () => {
    const slow = join(m.root, 'slow')
    await writeFile(slow, '#!/bin/sh\nsleep 5\n')
    await chmod(slow, 0o755)
    const result = await m.sys().run([slow], { timeoutMs: 50 })
    expect(result).toMatchObject({ code: 124, timedOut: true })
  })

  it('keeps the fake claude script in sync with the recorder', () => {
    expect(FAKE_CLAUDE).toContain('FAKE_LOG')
  })
})

describe('current agent', () => {
  it('reads the agents’ own env first', async () => {
    expect(await detectCurrentAgent({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' })).toEqual({
      name: 'claude',
      id: 'claude-code',
      sandboxed: false,
      sessionKey: 's1',
    })
    expect(await detectCurrentAgent({ CODEX_THREAD_ID: 't1', CODEX_SANDBOX: 'seatbelt' })).toMatchObject({
      id: 'codex',
      sessionKey: 't1',
      sandboxed: true,
    })
    const desktop = { CODEX_THREAD_ID: 't', CODEX_CLI_PATH: '/Applications/ChatGPT.app/Contents/x/codex' }
    expect((await detectCurrentAgent(desktop))?.id).toBe('codex-desktop')
    expect(await detectCurrentAgent({ CLAUDECODE: '1', CLAUDE_CODE_IS_COWORK: '1' })).toEqual({
      name: 'cowork',
      sandboxed: false,
    })
  })

  it('falls back to @vercel/detect-agent and maps unsupported agents to no id', async () => {
    expect(await detectCurrentAgent({})).toBeUndefined()
    const cursor = async () => ({ isAgent: true, agent: { name: 'cursor' } })
    expect(await detectCurrentAgent({}, cursor)).toEqual({ name: 'cursor', sandboxed: false })
    const claude = async () => ({ isAgent: true, agent: { name: 'claude' } })
    expect((await detectCurrentAgent({}, claude))?.id).toBe('claude-code')
    expect(await detectCurrentAgent({}, async () => ({ isAgent: false }))).toBeUndefined()
  })
})

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}
