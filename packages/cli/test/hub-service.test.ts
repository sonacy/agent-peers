import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult } from '../src/agents/types'
import type { ServiceDeps } from '../src/commands/hub-service'
import {
  LAUNCHD_LABEL,
  managerFor,
  parseLaunchdPrint,
  quoteSystemd,
  renderPlist,
  renderUnit,
  resolveServiceBinary,
  type ServiceSpec,
  statusLines,
} from '../src/service/index'
import { runCli } from './helpers/hub-cli'

interface Recorder {
  readonly calls: string[][]
  readonly deps: (platform: NodeJS.Platform) => ServiceDeps
  answer(prefix: string, result: Partial<RunResult>): void
}

function recorder(userHome: string): Recorder {
  const calls: string[][] = []
  const answers = new Map<string, Partial<RunResult>>()
  return {
    calls,
    answer: (prefix, result) => answers.set(prefix, result),
    deps: (platform) => ({
      platform,
      uid: 501,
      userHome,
      compiled: false,
      run: async (argv) => {
        calls.push([...argv])
        const joined = argv.join(' ')
        const hit = [...answers.entries()].find(([prefix]) => joined.startsWith(prefix))?.[1]
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...hit }
      },
    }),
  }
}

let dir: string
let env: Record<string, string>
let rec: Recorder

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aps-'))
  const binary = join(dir, 'agent-peers-build')
  await writeFile(binary, '#!/bin/sh\necho fake\n', { mode: 0o755 })
  env = { HOME: dir, AGENT_PEERS_HOME: join(dir, 'peers'), AGENT_PEERS_BINARY: binary }
  rec = recorder(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const service = (platform: NodeJS.Platform, ...argv: string[]) =>
  runCli(argv, env, { hub: { service: rec.deps(platform) } })

describe('hub service on macOS (launchd)', () => {
  it('installs the binary, writes the plist with the hub flags and bootstraps it', async () => {
    const result = await service(
      'darwin',
      'hub',
      '--public-url',
      'https://hub.example.com',
      '--port',
      '8000',
      'service',
      'install',
    )
    expect(result.code).toBe(0)
    const plistPath = join(dir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    const current = join(dir, 'peers', 'bin', 'current')
    expect(await readlink(current)).toBe('agent-peers-0.1.0')
    const plist = await readFile(plistPath, 'utf8')
    const dataDir = join(dir, 'peers', 'hub')
    expect(plist).toContain(`<string>${current}</string>\n    <string>hub</string>`)
    expect(plist).toContain('<string>--public-url</string>\n    <string>https://hub.example.com</string>')
    expect(plist).toContain('<string>--port</string>\n    <string>8000</string>')
    expect(plist).toContain(`<string>--data-dir</string>\n    <string>${dataDir}</string>`)
    expect(plist).toContain(`<key>AGENT_PEERS_HOME</key>\n    <string>${join(dir, 'peers')}</string>`)
    expect(plist).toContain(`<string>${join(dataDir, 'hub.log')}</string>`)
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700)
    expect(rec.calls).toEqual([
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ])
    expect(result.out).toContain(`installed ${current}`)
    expect(result.out).toContain(`logs: ${join(dataDir, 'hub.log')}`)
    expect(result.err).toBe('')
  })

  it('reports status from launchctl print and uninstalls', async () => {
    const before = await service('darwin', 'hub', 'service', 'status')
    expect(before.code).toBe(1)
    expect(before.out).toContain('hub service: not installed')
    await service('darwin', 'hub', 'service', 'install')
    rec.answer('launchctl print', { stdout: '\tstate = running\n\tpid = 4242\n' })
    const status = await service('darwin', 'hub', 'service', 'status')
    expect(status.code).toBe(0)
    expect(status.out).toContain('hub service: running (pid 4242)')
    const json = await service('darwin', '--json', 'hub', 'service', 'status')
    expect(JSON.parse(json.out)).toMatchObject({
      manager: 'launchd',
      installed: true,
      running: true,
      pid: 4242,
    })
    const removed = await service('darwin', 'hub', 'service', 'uninstall')
    expect(removed.code).toBe(0)
    expect(removed.out).toContain('stopped and unloaded dev.agent-peers.hub')
    expect(existsSync(join(dir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))).toBe(false)
    const again = await service('darwin', 'hub', 'service', 'uninstall')
    expect(again.out).toContain('no hub service installed')
  })

  it('fails when launchctl bootstrap fails', async () => {
    rec.answer('launchctl bootstrap', { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' })
    const result = await service('darwin', 'hub', 'service', 'install')
    expect(result.code).toBe(1)
    expect(result.err).toContain('launchctl bootstrap failed: Bootstrap failed: 5')
  })

  it('warns when the service could not mint invites', async () => {
    const result = await service('darwin', 'hub', 'service', 'install')
    expect(result.err).toContain('without --public-url, so it refuses to mint invites')
    const loopback = await service('darwin', 'hub', '--bind', '127.0.0.1', 'service', 'install')
    expect(loopback.err).toContain('only agents on this machine can join')
  })
})

describe('hub service on Linux (systemd --user)', () => {
  it('writes the unit under XDG_CONFIG_HOME and enables it', async () => {
    env = { ...env, XDG_CONFIG_HOME: join(dir, 'xdg') }
    const result = await service('linux', 'hub', '--registration', 'open', 'service', 'install')
    expect(result.code).toBe(0)
    const unitPath = join(dir, 'xdg', 'systemd', 'user', 'agent-peers-hub.service')
    const unit = await readFile(unitPath, 'utf8')
    expect(unit).toContain(`ExecStart="${join(dir, 'peers', 'bin', 'current')}" "hub" "--data-dir"`)
    expect(unit).toContain('"--registration" "open"')
    expect(unit).toContain(`Environment="AGENT_PEERS_HOME=${join(dir, 'peers')}"`)
    expect(unit).toContain('WantedBy=default.target')
    expect(rec.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'agent-peers-hub.service'],
      ['systemctl', '--user', 'restart', 'agent-peers-hub.service'],
    ])
    expect(result.out).toContain('loginctl enable-linger')
  })

  it('reports status and uninstalls with a daemon-reload', async () => {
    await service('linux', 'hub', 'service', 'install')
    rec.answer('systemctl --user is-active', { stdout: 'active\n' })
    rec.answer('systemctl --user show', { stdout: '777\n' })
    const status = await service('linux', 'hub', 'service', 'status')
    expect(status.out).toContain('hub service: running (pid 777)')
    rec.calls.length = 0
    const removed = await service('linux', 'hub', 'service', 'uninstall')
    expect(removed.code).toBe(0)
    expect(rec.calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'agent-peers-hub.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ])
    expect(existsSync(join(dir, '.config', 'systemd', 'user', 'agent-peers-hub.service'))).toBe(false)
  })

  it('surfaces a failing systemctl', async () => {
    rec.answer('systemctl --user enable', { code: 1, stdout: 'Failed to connect to bus' })
    const result = await service('linux', 'hub', 'service', 'install')
    expect(result.code).toBe(1)
    expect(result.err).toContain(
      'systemctl --user enable agent-peers-hub.service failed: Failed to connect to bus',
    )
  })
})

describe('service helpers', () => {
  const spec: ServiceSpec = {
    binary: '/opt/a b/agent-peers',
    args: ['hub', '--public-url', 'https://x.test/?a=1&b=<2>'],
    env: { AGENT_PEERS_HOME: '/h' },
    logPath: '/h/hub/hub.log',
    workingDir: '/h/hub',
  }

  it('escapes plist XML and systemd words', () => {
    expect(renderPlist(spec)).toContain('<string>https://x.test/?a=1&amp;b=&lt;2&gt;</string>')
    expect(quoteSystemd('50% $HOME "q" \\')).toBe('"50%% $$HOME \\"q\\" \\\\"')
    expect(() => quoteSystemd('a\nb')).toThrow('newlines')
    expect(renderUnit(spec)).toContain('ExecStart="/opt/a b/agent-peers" "hub"')
  })

  it('parses launchctl print and formats status', () => {
    expect(parseLaunchdPrint('state = waiting\n')).toEqual({ running: false })
    const base = { manager: 'systemd' as const, unitPath: '/u', installed: true }
    expect(statusLines({ ...base, loaded: true, running: false })[0]).toBe('hub service: loaded, not running')
    expect(statusLines({ ...base, loaded: false, running: false })[0]).toBe(
      'hub service: installed, not loaded',
    )
  })

  it('refuses unsupported platforms', async () => {
    expect(() => managerFor('win32')).toThrow('not win32')
    const result = await service('win32', 'hub', 'service', 'status')
    expect(result.code).toBe(2)
  })

  it('prefers an installed binary and needs one when running from source', async () => {
    const home = join(dir, 'h2')
    await expect(resolveServiceBinary(home, {}, '0.1.0', false)).rejects.toThrow(
      'run "agent-peers add" first',
    )
    await mkdir(join(home, 'bin'), { recursive: true })
    await symlink('agent-peers-0.0.9', join(home, 'bin', 'current'))
    expect(await resolveServiceBinary(home, {}, '0.1.0', false)).toEqual({
      path: join(home, 'bin', 'current'),
      installed: false,
    })
  })
})
