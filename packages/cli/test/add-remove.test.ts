import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promptOptions, selectAgents } from '../src/commands/add-select'
import type { SelectPrompt } from '../src/commands/installer-deps'
import { readInstallState } from '../src/install/state'
import { main } from '../src/program'
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

async function everyAgent(): Promise<void> {
  await installFakeClaude(m)
  await installFakeCodex(m)
  await installFakeCodexApp(m)
  await installFakeClaudeDesktop(m, { preferences: { a: 1 } })
}

async function run(argv: readonly string[], extra = {}) {
  const io = m.io()
  const code = await main(argv, io, { installer: m.deps(extra) })
  return { code, out: normalize(m, io.out.join('')), err: normalize(m, io.err.join('')) }
}

describe('agent-peers add', () => {
  it('-y installs into every supported agent, selftests, records and prints FINISH', async () => {
    await everyAgent()
    const result = await run(['add', '-y'])
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain(
      'installing into: Claude Code, Claude Desktop, Codex CLI, Codex desktop (-y)',
    )
    expect(result.out).toContain('selftest claude-code: agent-peers mcp selftest ok (claude-code)')
    expect(result.out).toContain('selftest claude-desktop: agent-peers mcp selftest ok (claude-desktop)')
    const finish = result.out.slice(result.out.indexOf('[agent-peers] FINISH:'))
    expect(finish).toMatchSnapshot()
    const state = await readInstallState(m.peersHome)
    expect(Object.keys(state)).toEqual(['claude-code', 'claude-desktop', 'codex', 'codex-desktop'])
    expect(state['claude-code']).toMatchObject({ version: '0.1.0', method: 'marketplace' })
    expect(JSON.parse(await readFile(join(m.peersHome, 'config.json'), 'utf8'))).toBeTruthy()
    const second = await run(['add', '-y'])
    expect(second.code).toBe(0)
    expect(second.out).toContain('up to date')
  })

  it('--dry-run prints the plan and changes nothing', async () => {
    await everyAgent()
    const result = await run(['add', '-a', 'codex', '-a', 'claude-desktop', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.out.slice(result.out.indexOf('dry run'))).toMatchSnapshot()
    expect(await Bun.file(join(m.peersHome, 'bin', 'current')).exists()).toBe(false)
    expect((await m.calls()).some((call) => call.includes('plugin'))).toBe(false)
  })

  it('--here installs only into the agent running the command', async () => {
    await everyAgent()
    m.env = { ...m.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }
    const result = await run(['add', '--here'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('installing into: Claude Code (--here (claude))')
    expect(Object.keys(await readInstallState(m.peersHome))).toEqual(['claude-code'])
  })

  it('--here outside a supported agent is a usage error', async () => {
    expect((await run(['add', '--here'])).code).toBe(2)
    const cursor = await run(['add', '--here'], {
      determineAgent: async () => ({ isAgent: true, agent: { name: 'cursor' } }),
    })
    expect(cursor.err).toContain('"cursor", which agent-peers v0 does not support')
  })

  it('stops with exit 3 inside the Codex sandbox', async () => {
    await installFakeCodex(m)
    m.env = { ...m.env, CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: 't1' }
    const result = await run(['add', '-a', 'codex'])
    expect(result.code).toBe(3)
    expect(result.err).toContain("blocked by your agent's sandbox")
    expect(result.err).toContain('agent-peers add -a codex')
  })

  it('reports unsupported, missing and unknown agents', async () => {
    await installFakeCodex(m)
    m.env = { ...m.env, FAKE_CODEX_VERSION: '0.150.0' }
    const old = await run(['add', '-a', 'codex'])
    expect(old.code).toBe(1)
    expect(old.out).toContain('Codex CLI: skipped (Codex CLI 0.150.0 is too old')
    expect((await run(['add', '-y'])).err).toContain('no supported agent selected')
    const unknown = await run(['add', '-a', 'cursor'])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('unknown agent "cursor"')
  })

  it('needs a binary to install', async () => {
    await installFakeClaude(m)
    const result = await run(['add', '-y'], { sourceBinary: undefined })
    expect(result.code).toBe(1)
    expect(result.err).toContain('no binary to install')
  })

  it('fails loudly when the installed bridge cannot start', async () => {
    await installFakeClaudeDesktop(m)
    m.env = { ...m.env, FAKE_SELFTEST_FAIL: '1' }
    const result = await run(['add', '-y'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('selftest claude-desktop failed')
  })

  it('prompts when interactive, pre-checking the previous selection', async () => {
    await everyAgent()
    let seen: { options: unknown; initial: unknown } | undefined
    const prompt: SelectPrompt = async (options, initial) => {
      seen = { options, initial }
      return ['claude-desktop']
    }
    const result = await run(['add'], { interactive: true, prompt })
    expect(result.code).toBe(0)
    expect(seen?.initial).toEqual(['claude-code', 'claude-desktop', 'codex', 'codex-desktop'])
    const again = await run(['add'], { interactive: true, prompt })
    expect(again.code).toBe(0)
    expect(seen?.initial).toEqual(['claude-desktop'])
    const cancelled = await run(['add'], { interactive: true, prompt: async () => undefined })
    expect(cancelled).toMatchObject({ code: 1, err: 'agent-peers: cancelled\n' })
  })
})

describe('add selection', () => {
  it('greys out agents that are detected but unsupported', () => {
    const options = promptOptions([
      {
        id: 'codex',
        label: 'Codex CLI',
        detected: true,
        supported: false,
        reason: 'too old',
        configDir: '',
        evidence: [],
        notes: [],
      },
      {
        id: 'claude-code',
        label: 'Claude Code',
        detected: true,
        supported: true,
        version: '2.1.296',
        configDir: '',
        evidence: [],
        notes: [],
      },
      {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        detected: true,
        supported: true,
        configDir: '',
        evidence: [],
        notes: [],
      },
      {
        id: 'codex-desktop',
        label: 'Codex desktop',
        detected: false,
        supported: false,
        configDir: '',
        evidence: [],
        notes: [],
      },
    ])
    expect(options).toEqual([
      { value: 'codex', label: 'Codex CLI', hint: 'too old', disabled: true },
      { value: 'claude-code', label: 'Claude Code', hint: '2.1.296' },
      { value: 'claude-desktop', label: 'Claude Desktop' },
    ])
  })

  it('treats running inside an agent as non-interactive', async () => {
    const selection = await selectAgents({
      detections: [],
      explicit: [],
      here: false,
      yes: false,
      current: { name: 'codex', id: 'codex', sandboxed: false },
      interactive: true,
      previous: [],
      prompt: async () => {
        throw new Error('must not prompt')
      },
    })
    expect(selection).toEqual({ kind: 'agents', ids: [], mode: 'inside codex' })
  })
})

describe('agent-peers remove', () => {
  it('reverses add, keeping config and credentials, then purges binaries', async () => {
    await everyAgent()
    expect((await run(['add', '-y'])).code).toBe(0)
    await writeFile(join(m.peersHome, 'credentials.json'), '{"hubs":{}}')
    const result = await run(['remove'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('removed <TMP>/home/.agent-peers/plugins and <TMP>/home/.agent-peers/bin')
    expect(await readInstallState(m.peersHome)).toEqual({})
    const left = (await readdir(m.peersHome)).sort()
    expect(left).toContain('config.json')
    expect(left).toContain('credentials.json')
    expect(left).not.toContain('bin')
    const desktop = join(m.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    expect(JSON.parse(await readFile(desktop, 'utf8'))).toEqual({ preferences: { a: 1 }, mcpServers: {} })
    expect((await run(['remove'])).out).toContain('nothing to remove')
  })

  it('keeps the shared Codex install while the other Codex surface stays', async () => {
    await installFakeCodex(m)
    await installFakeCodexApp(m)
    expect((await run(['add', '-y'])).code).toBe(0)
    const result = await run(['remove', '-a', 'codex'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('kept the shared plugin install: Codex desktop still uses it')
    expect(Object.keys(await readInstallState(m.peersHome))).toEqual(['codex-desktop'])
    expect(await Bun.file(join(m.peersHome, 'bin', 'current')).exists()).toBe(true)
  })

  it('--dry-run lists what would be removed', async () => {
    await installFakeClaudeDesktop(m)
    expect((await run(['add', '-y'])).code).toBe(0)
    const result = await run(['remove', '--dry-run'])
    expect(result.out).toContain('dry run, would remove agent-peers from:\n  Claude Desktop')
    expect(Object.keys(await readInstallState(m.peersHome))).toEqual(['claude-desktop'])
  })

  it('finds installs that were not recorded', async () => {
    await installFakeClaudeDesktop(m, {
      mcpServers: { 'agent-peers-desktop': { command: '/x', args: [] } },
    })
    const result = await run(['remove'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('Claude Desktop:')
  })
})
