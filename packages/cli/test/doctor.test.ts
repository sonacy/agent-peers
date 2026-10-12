import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ControlHandler, ControlServer } from '@agent-peers/core'
import { renderReport } from '../src/commands/doctor'
import { checkHub } from '../src/commands/doctor-checks'
import { main } from '../src/program'
import {
  type FakeMachine,
  fakeMachine,
  installFakeClaude,
  installFakeClaudeDesktop,
  installFakeCodex,
  normalize,
} from './helpers/fake-agents'

let m: FakeMachine
beforeEach(async () => {
  m = await fakeMachine()
})
afterEach(async () => {
  await m.cleanup()
})

interface Report {
  readonly ok: boolean
  readonly checks: readonly { id: string; agent?: string; status: string; summary: string }[]
}

async function doctor(extra = {}): Promise<{ code: number | undefined; report: Report }> {
  const io = m.io()
  const code = await main(['doctor', '--json'], io, { installer: m.deps({ probeTimeoutMs: 2000, ...extra }) })
  return { code, report: JSON.parse(normalize(m, io.out.join(''))) as Report }
}

const statusOf = (report: Report, id: string, agent?: string) =>
  report.checks.find((c) => c.id === id && (agent === undefined || c.agent === agent))?.status

/** A bridge's control socket answering the synthetic `permission` op. */
const probeHandler: ControlHandler = {
  register: async () => ({}),
  activity: async () => ({}),
  take: async () => null,
  wait: async () => null,
  turn_end: async () => ({}),
  end: async () => ({}),
  gate: async () => ({ decision: 'allow', reason: 'test' }),
  permission: async () => ({ reason: 'not a peer turn' }),
  autojoin: async () => ({ accepted: false }),
}

describe('agent-peers doctor', () => {
  it('fails on a machine where nothing is installed', async () => {
    const { code, report } = await doctor()
    expect(code).toBe(1)
    expect(statusOf(report, 'binary')).toBe('fail')
    expect(statusOf(report, 'bridge')).toBe('skip')
    expect(statusOf(report, 'hub')).toBe('skip')
    expect(statusOf(report, 'detect', 'codex')).toBe('skip')
  })

  it('passes end to end after add: plugins, gate, selftest, bridge round-trip, hub', async () => {
    await installFakeClaude(m)
    await installFakeCodex(m)
    await installFakeClaudeDesktop(m)
    const add = await main(['add', '-y'], m.io(), { installer: m.deps() })
    expect(add).toBe(0)
    const listed = [
      {
        id: 'peers@agent-peers',
        enabled: true,
        installPath: join(m.peersHome, 'plugins', '0.1.0', 'marketplace', 'plugins', 'peers'),
      },
    ]
    m.env = { ...m.env, FAKE_CLAUDE_PLUGINS: JSON.stringify(listed) }
    const hub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new Response(new URL(req.url).pathname === '/install.sh' ? '#!/bin/sh\n' : 'no', {
          status: new URL(req.url).pathname === '/install.sh' ? 200 : 404,
        }),
    })
    await writeFile(
      join(m.peersHome, 'config.json'),
      JSON.stringify({ default_hub: `http://127.0.0.1:${hub.port}` }),
    )
    const bridge = await ControlServer.start({
      runDir: join(m.peersHome, 'run'),
      handler: probeHandler,
      agentKind: 'claude-code',
      ancestorPids: [process.pid],
      agentPid: process.pid,
    })
    try {
      const { code, report } = await doctor()
      const failures = report.checks.filter((c) => c.status === 'fail')
      expect(failures).toEqual([])
      expect(code).toBe(0)
      expect(statusOf(report, 'plugin', 'claude-code')).toBe('ok')
      expect(statusOf(report, 'gate', 'claude-code')).toBe('ok')
      expect(statusOf(report, 'gate', 'codex')).toBe('ok')
      expect(statusOf(report, 'gate', 'claude-desktop')).toBe('skip')
      expect(statusOf(report, 'hooks', 'codex')).toBe('warn')
      expect(statusOf(report, 'bridge')).toBe('ok')
      expect(statusOf(report, 'hub')).toBe('ok')
      expect(report.checks.filter((c) => c.id === 'mcp').map((c) => c.summary)).toEqual([
        'selftest claude-code: agent-peers mcp selftest ok (claude-code)',
        'selftest claude-desktop: agent-peers mcp selftest ok (claude-desktop)',
        'selftest codex: agent-peers mcp selftest ok (codex)',
      ])
    } finally {
      await bridge.close()
      hub.stop(true)
    }
  })

  it('fails a recorded agent whose plugin disappeared, and prints a text report', async () => {
    await installFakeClaudeDesktop(m)
    expect(await main(['add', '-y'], m.io(), { installer: m.deps() })).toBe(0)
    const config = join(m.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    await writeFile(config, '{}')
    const io = m.io()
    const code = await main(['doctor'], io, { installer: m.deps() })
    expect(code).toBe(1)
    const text = normalize(m, io.out.join(''))
    expect(text).toContain('FAIL  claude-desktop plugin:')
    expect(text).toContain('rerun agent-peers add -a claude-desktop')
    expect(text.split('\n').at(-2)).toMatch(/\d+ ok, \d+ warnings, 1 failed, \d+ skipped/)
  })

  it('reports an unreachable bridge and a broken config.json', async () => {
    const run = join(m.peersHome, 'run')
    await mkdir(run, { recursive: true })
    const info = { pid: process.pid, ancestor_pids: [], agent_kind: 'codex', local_keys: [], started_at: 1 }
    await writeFile(join(run, `${process.pid}.json`), JSON.stringify(info))
    await writeFile(join(m.peersHome, 'config.json'), '{ broken')
    const { report } = await doctor({ probeTimeoutMs: 200 })
    expect(statusOf(report, 'bridge')).toBe('fail')
    expect(statusOf(report, 'config')).toBe('fail')
  })
})

describe('hub check', () => {
  const ok = (async () => new Response('ok')) as unknown as typeof fetch

  it('enforces the TLS rule and reports HTTP failures', async () => {
    expect((await checkHub('http://hub.example.com', ok, 100)).summary).toContain(
      'plain http to a public host',
    )
    expect((await checkHub('https://hub.example.com', ok, 100)).summary).toBe(
      'https://hub.example.com reachable (TLS)',
    )
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect((await checkHub('https://hub.example.com', notFound, 100)).summary).toContain('HTTP 404')
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect((await checkHub('http://192.168.1.2:7337', down, 100)).summary).toContain(
      'unreachable (ECONNREFUSED)',
    )
  })

  it('renders a summary line', () => {
    const lines = renderReport({ ok: true, checks: [{ id: 'hub', status: 'skip', summary: 'none' }] })
    expect(lines).toEqual([
      'agent-peers doctor',
      '  skip  hub: none',
      '0 ok, 0 warnings, 0 failed, 1 skipped',
    ])
  })
})
