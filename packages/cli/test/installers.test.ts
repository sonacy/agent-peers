import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectAll } from '../src/agents/registry'
import type { AgentDetection, AgentId } from '../src/agents/types'
import {
  describeStep,
  formatArgv,
  lastJsonValue,
  parseJsonOutput,
  runCliStep,
  stepError,
} from '../src/install/exec'
import { type InstallContext, installerFor, prepareInstall, selftest } from '../src/install/index'
import {
  type FakeMachine,
  fakeMachine,
  installFakeClaude,
  installFakeClaudeDesktop,
  installFakeCodex,
  installFakeCodexApp,
  normalize,
} from './helpers/fake-agents'

let m: FakeMachine
beforeEach(async () => {
  m = await fakeMachine()
})
afterEach(async () => {
  await m.cleanup()
})

async function setup(): Promise<{ ctx: InstallContext; detect: (id: AgentId) => Promise<AgentDetection> }> {
  const { ctx } = await prepareInstall(m.sys(), m.peersHome, '0.1.0', m.source)
  return {
    ctx,
    detect: async (id) => {
      const found = (await detectAll(m.sys())).find((d) => d.id === id)
      if (!found) throw new Error(id)
      return found
    },
  }
}

/** The context with a Sys that sees the current `m.env`. */
const fresh = (ctx: InstallContext): InstallContext => ({ ...ctx, sys: m.sys() })

const argvOf = async (name: string) =>
  (await m.calls()).filter((call) => call[0] === name).map((call) => normalize(m, call.slice(1).join(' ')))

describe('claude-code installer', () => {
  it('installs in one step on 2.1.292+', async () => {
    await installFakeClaude(m)
    const { ctx, detect } = await setup()
    const outcome = await installerFor('claude-code').install(await detect('claude-code'), ctx)
    expect(outcome).toMatchObject({ ok: true, changed: true, method: 'marketplace' })
    expect(await argvOf('claude')).toEqual([
      '--version',
      'plugin marketplace list --json',
      'plugin install peers --marketplace <TMP>/home/.agent-peers/plugins/0.1.0/marketplace --scope user --json',
    ])
  })

  it('uses the two-step flow before 2.1.292 and drops a marketplace from an older version', async () => {
    await installFakeClaude(m)
    const stale = [{ name: 'agent-peers', source: 'directory', path: '/old/plugins/0.0.9/marketplace' }]
    m.env = { ...m.env, FAKE_CLAUDE_VERSION: '2.1.280', FAKE_CLAUDE_MARKETPLACES: JSON.stringify(stale) }
    const { ctx, detect } = await setup()
    const detection = await detect('claude-code')
    expect(
      installerFor('claude-code')
        .plan(detection, ctx)
        .map((line) => normalize(m, line)),
    ).toMatchSnapshot()
    expect((await installerFor('claude-code').install(detection, ctx)).ok).toBe(true)
    expect((await argvOf('claude')).slice(2)).toEqual([
      'plugin marketplace remove agent-peers',
      'plugin marketplace add <TMP>/home/.agent-peers/plugins/0.1.0/marketplace',
      'plugin install peers@agent-peers --scope user --json',
    ])
  })

  it('falls back to the skills dir when the plugin CLI fails, and cleans it up later', async () => {
    await installFakeClaude(m)
    m.env = { ...m.env, FAKE_CLAUDE_FAIL: 'plugin install' }
    const { ctx, detect } = await setup()
    const outcome = await installerFor('claude-code').install(await detect('claude-code'), ctx)
    expect(outcome).toMatchObject({ ok: true, method: 'skills-dir' })
    expect(outcome.lines.join('\n')).toContain('failed: boom')
    const skills = join(m.home, '.claude', 'skills', 'peers')
    expect(await readFile(join(skills, 'bin', 'agent-peers'), 'utf8')).toContain(ctx.binary)
    expect(installerFor('claude-code').finish('skills-dir')).toContain('new Claude Code session')
    m.env = { ...m.env, FAKE_CLAUDE_FAIL: '' }
    const again = await installerFor('claude-code').install(await detect('claude-code'), fresh(ctx))
    expect(again).toMatchObject({ ok: true, method: 'marketplace' })
    expect(await Bun.file(join(skills, '.agent-peers-install.json')).exists()).toBe(false)
  })

  it('never overwrites a skills/peers folder it did not create', async () => {
    await mkdir(join(m.home, '.claude', 'skills', 'peers'), { recursive: true })
    const { ctx, detect } = await setup()
    const outcome = await installerFor('claude-code').install(await detect('claude-code'), ctx)
    expect(outcome.ok).toBe(false)
    expect(outcome.lines[0]).toContain('was not created by agent-peers')
  })

  it('reports status from claude plugin list and uninstalls', async () => {
    await installFakeClaude(m)
    const listed = [{ id: 'peers@agent-peers', enabled: true, installPath: '/cache/peers', scope: 'user' }]
    m.env = { ...m.env, FAKE_CLAUDE_PLUGINS: JSON.stringify(listed) }
    const { ctx, detect } = await setup()
    const detection = await detect('claude-code')
    expect(await installerFor('claude-code').status(detection, ctx)).toMatchObject({
      installed: true,
      enabled: true,
      pluginPath: '/cache/peers',
    })
    expect((await installerFor('claude-code').uninstall(detection, ctx)).ok).toBe(true)
    expect((await argvOf('claude')).slice(-2)).toEqual([
      'plugin uninstall peers@agent-peers --scope user --json',
      'plugin marketplace remove agent-peers --json',
    ])
    m.env = { ...m.env, FAKE_CLAUDE_PLUGINS: '[]' }
    expect((await installerFor('claude-code').status(detection, fresh(ctx))).installed).toBe(false)
  })
})

describe('codex installers', () => {
  it('adds the marketplace and plugin, then pre-approves the reply tools with a backup', async () => {
    await installFakeCodex(m)
    await mkdir(join(m.home, '.codex'), { recursive: true })
    await writeFile(join(m.home, '.codex', 'config.toml'), '# mine\nmodel = "gpt-6"\n')
    const { ctx, detect } = await setup()
    const detection = await detect('codex')
    const outcome = await installerFor('codex').install(detection, ctx)
    expect(outcome.ok).toBe(true)
    expect(outcome.lines.map((line) => normalize(m, line))).toMatchSnapshot()
    expect(await readFile(join(m.home, '.codex', 'config.toml'), 'utf8')).toMatchSnapshot()
    const backups = (await readdir(join(m.home, '.codex'))).filter((name) => name.endsWith('.bak'))
    expect(backups).toEqual(['config.toml.agent-peers-20251009T085320Z.bak'])
    const again = await installerFor('codex').install(detection, ctx)
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(await installerFor('codex').status(detection, ctx)).toMatchObject({
      installed: true,
      enabled: true,
      hooksTrusted: false,
    })
  })

  it('replaces a marketplace added from another folder, through the desktop engine', async () => {
    await installFakeCodexApp(m)
    await writeFile(m.env.FAKE_STATE ?? '', '/old/codex-marketplace')
    const { ctx, detect } = await setup()
    const outcome = await installerFor('codex-desktop').install(await detect('codex-desktop'), ctx)
    expect(outcome.ok).toBe(true)
    expect((await argvOf('codex')).slice(1)).toEqual([
      'plugin marketplace add <TMP>/home/.agent-peers/plugins/0.1.0/codex-marketplace --json',
      'plugin remove peers@agent-peers --json',
      'plugin marketplace remove agent-peers',
      'plugin marketplace add <TMP>/home/.agent-peers/plugins/0.1.0/codex-marketplace --json',
      'plugin add peers@agent-peers --json',
    ])
    expect(installerFor('codex-desktop').finish()).toContain('Review hooks')
  })

  it('uninstalls the plugin and the approvals, leaving the rest of config.toml', async () => {
    await installFakeCodex(m)
    const { ctx, detect } = await setup()
    const detection = await detect('codex')
    await installerFor('codex').install(detection, ctx)
    const outcome = await installerFor('codex').uninstall(detection, ctx)
    expect(outcome.ok).toBe(true)
    expect(await readFile(join(m.home, '.codex', 'config.toml'), 'utf8')).toBe('')
    expect((await installerFor('codex').status(detection, ctx)).installed).toBe(false)
  })

  it('fails without a binary and on invalid config.toml', async () => {
    await installFakeCodex(m)
    await mkdir(join(m.home, '.codex'), { recursive: true })
    await writeFile(join(m.home, '.codex', 'config.toml'), 'not = = toml')
    const { ctx, detect } = await setup()
    const detection = await detect('codex')
    const outcome = await installerFor('codex').install(detection, ctx)
    expect(outcome.ok).toBe(false)
    expect(outcome.lines.at(-1)).toContain('not valid TOML')
    const { binary: _b, ...noBinary } = detection
    expect((await installerFor('codex').install(noBinary, ctx)).ok).toBe(false)
    expect((await installerFor('codex').status(detection, ctx)).installed).toBe(false)
  })
})

describe('claude-desktop installer', () => {
  const OTHER = { preferences: { theme: 'dark' }, mcpServers: { other: { command: '/bin/other', args: [] } } }

  it('merges its server, keeps every other key, backs up, and is idempotent', async () => {
    const dir = await installFakeClaudeDesktop(m, OTHER)
    const { ctx, detect } = await setup()
    const detection = await detect('claude-desktop')
    const outcome = await installerFor('claude-desktop').install(detection, ctx)
    expect(outcome).toMatchObject({ ok: true, changed: true })
    const config = await readFile(join(dir, 'claude_desktop_config.json'), 'utf8')
    expect(normalize(m, config)).toMatchSnapshot()
    expect((await readdir(dir)).filter((name) => name.endsWith('.bak')).length).toBe(1)
    expect((await installerFor('claude-desktop').install(detection, ctx)).changed).toBe(false)
    expect(await installerFor('claude-desktop').status(detection, ctx)).toMatchObject({
      installed: true,
      enabled: true,
    })
    const removed = await installerFor('claude-desktop').uninstall(detection, ctx)
    expect(removed.changed).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'claude_desktop_config.json'), 'utf8'))).toEqual(OTHER)
    expect((await installerFor('claude-desktop').uninstall(detection, ctx)).changed).toBe(false)
  })

  it('creates the config when missing and refuses invalid JSON', async () => {
    const dir = await installFakeClaudeDesktop(m)
    const { ctx, detect } = await setup()
    const detection = await detect('claude-desktop')
    expect((await installerFor('claude-desktop').uninstall(detection, ctx)).changed).toBe(false)
    expect((await installerFor('claude-desktop').status(detection, ctx)).installed).toBe(false)
    expect((await installerFor('claude-desktop').install(detection, ctx)).ok).toBe(true)
    await writeFile(join(dir, 'claude_desktop_config.json'), '{ nope')
    const bad = await installerFor('claude-desktop').install(detection, ctx)
    expect(bad.ok).toBe(false)
    expect(bad.lines[0]).toContain('is not valid JSON')
    expect((await installerFor('claude-desktop').uninstall(detection, ctx)).ok).toBe(false)
    expect((await installerFor('claude-desktop').status(detection, ctx)).installed).toBe(false)
    await writeFile(join(dir, 'claude_desktop_config.json'), '[1]')
    expect((await installerFor('claude-desktop').install(detection, ctx)).ok).toBe(false)
    expect((await installerFor('claude-desktop').uninstall(detection, ctx)).ok).toBe(false)
  })

  it('flags an entry whose command is not executable', async () => {
    await installFakeClaudeDesktop(m, {
      mcpServers: { 'agent-peers-desktop': { command: '/nope/agent-peers', args: ['x'] } },
    })
    const { ctx, detect } = await setup()
    const status = await installerFor('claude-desktop').status(await detect('claude-desktop'), ctx)
    expect(status).toMatchObject({ installed: true, enabled: false })
    expect(status.lines.length).toBe(3)
  })
})

describe('exec helpers and selftest', () => {
  it('parses JSON results and formats steps', async () => {
    expect(lastJsonValue('noise\n{"a":1}\n\n')).toEqual({ a: 1 })
    expect(lastJsonValue('none')).toBeUndefined()
    expect(parseJsonOutput('[\n  1\n]')).toEqual([1])
    expect(formatArgv(['claude', 'a b', "it's"])).toBe(`claude 'a b' 'it'\\''s'`)
    const step = await runCliStep(m.sys(), ['/bin/sh', '-c', 'echo bad >&2; exit 4'])
    expect(step.ok).toBe(false)
    expect(stepError(step)).toBe('bad')
    expect(describeStep(step)).toBe(`$ /bin/sh -c 'echo bad >&2; exit 4' -> failed: bad`)
    const silent = await runCliStep(m.sys(), ['/bin/sh', '-c', 'exit 5'])
    expect(stepError(silent)).toBe('exit code 5')
    const slow = await runCliStep(m.sys(), ['/bin/sh', '-c', 'sleep 5'], { timeoutMs: 50 })
    expect(stepError(slow)).toBe('timed out')
    const long = await runCliStep(m.sys(), ['/bin/sh', '-c', `printf 'x%.0s' $(seq 1 400) >&2; exit 1`])
    expect(stepError(long).length).toBe(300)
  })

  it('runs the installed bridge selftest', async () => {
    const { ctx } = await setup()
    expect(await selftest(m.sys(), ctx.binary, 'codex')).toEqual({
      ok: true,
      line: 'selftest codex: agent-peers mcp selftest ok (codex)',
    })
    m.env = { ...m.env, FAKE_SELFTEST_FAIL: '1' }
    const failed = await selftest(m.sys(), ctx.binary, 'codex')
    expect(failed.ok).toBe(false)
    expect(failed.line).toContain('selftest broke')
  })
})
