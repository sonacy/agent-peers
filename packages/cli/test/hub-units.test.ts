import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeersError } from '@agent-peers/protocol'
import { asAssetMap, assetsFromModule, dashboardLoader, isModuleMissing } from '../src/commands/hub-dashboard'
import {
  hubArgs,
  normalizePublicUrl,
  parsePort,
  resolveDataDir,
  resolveHubSettings,
} from '../src/commands/hub-options'
import {
  bootstrapLines,
  dialHost,
  hostForUrl,
  hubWarnings,
  isLoopbackBindHost,
  lanAddress,
  type StartedHub,
} from '../src/commands/hub-output'
import { cliLogger, processSignals, waitForStop } from '../src/commands/hub-run'
import {
  readAdminToken,
  readHubState,
  removeHubState,
  statePath,
  writeHubState,
} from '../src/commands/hub-state'
import { memoryIo } from './helpers/world'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apu-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('hub options', () => {
  it('parses ports and public URLs', () => {
    expect(parsePort('0')).toBe(0)
    expect(() => parsePort('-1')).toThrow('port number')
    expect(() => parsePort('1.5')).toThrow('port number')
    expect(normalizePublicUrl('https://hub.example.com///')).toBe('https://hub.example.com')
    expect(normalizePublicUrl('http://box:7337/peers/')).toBe('http://box:7337/peers')
    expect(() => normalizePublicUrl('not a url')).toThrow('is not a URL')
    expect(() => normalizePublicUrl('https://u:p@x.test')).toThrow('credentials')
  })

  it('resolves defaults and turns settings back into flags', () => {
    const defaults = resolveHubSettings({}, '/home/me/.agent-peers')
    expect(defaults).toMatchObject({
      port: 7337,
      bind: '0.0.0.0',
      adminPort: 7338,
      registration: 'invite-only',
    })
    expect(hubArgs(defaults)).toEqual(['--data-dir', '/home/me/.agent-peers/hub'])
    const custom = resolveHubSettings(
      {
        publicUrl: 'https://h.test',
        port: 1,
        bind: '127.0.0.1',
        adminPort: 2,
        adminBind: '::1',
        dataDir: '/d',
        registration: 'open',
        minAdapter: '0.2.0',
      },
      '/x',
    )
    expect(hubArgs(custom)).toEqual([
      '--public-url',
      'https://h.test',
      '--port',
      '1',
      '--bind',
      '127.0.0.1',
      '--admin-port',
      '2',
      '--admin-bind',
      '::1',
      '--data-dir',
      '/d',
      '--registration',
      'open',
      '--min-adapter',
      '0.2.0',
    ])
    expect(resolveDataDir('/x', 'rel')).toBe(join(process.cwd(), 'rel'))
  })
})

describe('hub output', () => {
  const settings = resolveHubSettings({}, '/h')
  const started: StartedHub = {
    version: '0.1.0',
    settings,
    publicPort: 7337,
    adminPort: 7338,
    publicUrl: undefined,
    dashboard: false,
  }

  it('suggests a LAN public URL for a wildcard bind', () => {
    expect(hubWarnings(started, () => '192.168.1.5')[1]).toContain('--public-url http://192.168.1.5:7337')
    expect(hubWarnings(started, () => undefined)[1]).toContain('http://<this-machine>:7337')
    expect(hubWarnings({ ...started, publicUrl: 'https://h.test' })).toEqual([])
  })

  it('picks addresses and hosts', () => {
    const iface = (address: string, internal = false) => ({
      address,
      netmask: '',
      family: 'IPv4' as const,
      mac: '',
      internal,
      cidr: null,
    })
    expect(lanAddress({ lo: [iface('127.0.0.1', true)], en0: [iface('8.8.8.8'), iface('10.0.0.2')] })).toBe(
      '10.0.0.2',
    )
    expect(lanAddress({ en0: [iface('8.8.8.8')] })).toBe('8.8.8.8')
    expect(lanAddress({})).toBeUndefined()
    expect(typeof (lanAddress() ?? '')).toBe('string')
    expect(dialHost('0.0.0.0')).toBe('127.0.0.1')
    expect(dialHost('::')).toBe('127.0.0.1')
    expect(hostForUrl('::1')).toBe('[::1]')
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false)
    expect(isLoopbackBindHost('localhost')).toBe(true)
  })

  it('prints the bootstrap invite even when no prompt could be rendered', () => {
    const lines = bootstrapLines({
      ...started,
      bootstrap: { inviteUrl: 'http://x/j/1', joinPrompt: undefined },
    })
    expect(lines).toEqual(['', 'created room "default". Invite link: http://x/j/1'])
  })
})

describe('dashboard assets', () => {
  it('accepts maps and records of files only', () => {
    const blob = new Blob(['x'])
    expect(
      asAssetMap(
        new Map<unknown, unknown>([
          ['a.js', blob],
          [1, 'x'],
          ['b', 5],
        ]),
      ),
    ).toEqual(new Map([['a.js', blob]]))
    expect(asAssetMap(new Map())).toBeUndefined()
    expect(asAssetMap({ 'index.html': '<p>', bad: 3 })).toEqual({ 'index.html': '<p>' })
    expect(asAssetMap([])).toBeUndefined()
    expect(asAssetMap(null)).toBeUndefined()
    expect(asAssetMap({})).toBeUndefined()
  })

  it('reads dashboardAssets() from the module', () => {
    expect(assetsFromModule({ dashboardAssets: () => ({ 'index.html': 'x' }) })).toEqual({
      'index.html': 'x',
    })
    expect(assetsFromModule({ dashboardAssets: () => undefined })).toBeUndefined()
    expect(assetsFromModule({ dashboardAssets: 3 })).toBeUndefined()
    expect(assetsFromModule({})).toBeUndefined()
    expect(assetsFromModule(undefined)).toBeUndefined()
  })

  it('tolerates a missing package and reports a broken one', async () => {
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    expect(await dashboardLoader('@agent-peers/does-not-exist')(warn)).toBeUndefined()
    expect(warnings).toEqual([])
    const broken = join(dir, 'broken.ts')
    await writeFile(broken, 'throw new Error("kaboom")\n')
    expect(await dashboardLoader(broken)(warn)).toBeUndefined()
    expect(warnings[0]).toContain('dashboard failed to load')
    const throwing = join(dir, 'throwing.ts')
    await writeFile(throwing, 'export function dashboardAssets() { throw new Error("no build") }\n')
    expect(await dashboardLoader(throwing)(warn)).toBeUndefined()
    expect(warnings[1]).toContain('dashboard assets failed to load')
    const good = join(dir, 'good.ts')
    await writeFile(good, 'export const dashboardAssets = () => new Map([["index.html", "ok"]])\n')
    expect(await dashboardLoader(good)(warn)).toEqual(new Map([['index.html', 'ok']]))
    expect(isModuleMissing({ code: 'MODULE_NOT_FOUND' }, 'x')).toBe(true)
    expect(isModuleMissing(new Error('Cannot find package "x"'), 'x')).toBe(true)
  })
})

describe('hub state file', () => {
  it('ignores missing and malformed state', async () => {
    const data = join(dir, 'state')
    expect(await readHubState(data)).toBeUndefined()
    await writeHubState(data, {
      pid: 7,
      version: '0.1.0',
      public_port: 1,
      admin_port: 2,
      admin_bind: '127.0.0.1',
      public_url: null,
      started_at: 1,
    })
    expect((await readHubState(data))?.pid).toBe(7)
    await removeHubState(data, 8)
    expect((await readHubState(data))?.pid).toBe(7)
    await writeFile(statePath(data), '{ nope')
    expect(await readHubState(data)).toBeUndefined()
    await writeFile(statePath(data), JSON.stringify({ pid: 1, admin_port: 'x' }))
    expect(await readHubState(data)).toBeUndefined()
    await writeFile(statePath(data), JSON.stringify([1]))
    expect(await readHubState(data)).toBeUndefined()
    await removeHubState(data, 1)
    expect(await readAdminToken(data)).toBeUndefined()
    await writeFile(join(data, 'admin-token'), '\n')
    expect(await readAdminToken(data)).toBeUndefined()
  })
})

describe('hub run helpers', () => {
  it('logs info only when verbose', () => {
    const io = memoryIo({})
    cliLogger(io, false).info('quiet')
    cliLogger(io, true).info('loud')
    cliLogger(io, false).error('bad', new PeersError('internal', 'x'))
    cliLogger(io, false).error('plain')
    expect(io.err).toEqual(['[hub] loud\n', 'error: bad PeersError: x\n', 'error: plain\n'])
  })

  it('waits for a real process signal', async () => {
    const stopped = waitForStop(processSignals)
    process.emit('SIGTERM')
    expect(await stopped).toBe('SIGTERM')
    expect(process.listenerCount('SIGINT')).toBe(0)
  })
})
