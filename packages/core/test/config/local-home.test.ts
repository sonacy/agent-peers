import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTextIfExists, writeJsonFile } from '../../src/config/fs'
import { LocalHome } from '../../src/config/local-home'
import {
  expandHome,
  infoPathFor,
  peersPaths,
  pidFromRunFile,
  resolvePeersHome,
  socketPathFor,
} from '../../src/config/paths'
import { listRunPids } from '../../src/config/run-dir'
import {
  DEFAULT_PEER_TURNS_PER_HOUR,
  defaultLocalConfig,
  hubOrigin,
  LocalConfigSchema,
} from '../../src/config/schemas'
import { errorCode } from '../helpers/error-code'

const mode = async (path: string) => (await stat(path)).mode & 0o777

describe('paths', () => {
  it('resolves AGENT_PEERS_HOME, expanding ~ and relative paths', () => {
    expect(resolvePeersHome({ AGENT_PEERS_HOME: '/x/y' }, '/home/u')).toBe('/x/y')
    expect(resolvePeersHome({ AGENT_PEERS_HOME: '~/peers' }, '/home/u')).toBe('/home/u/peers')
    expect(resolvePeersHome({ AGENT_PEERS_HOME: 'rel' }, '/home/u')).toBe(join(process.cwd(), 'rel'))
    expect(resolvePeersHome({ AGENT_PEERS_HOME: '  ' }, '/home/u')).toBe('/home/u/.agent-peers')
    expect(resolvePeersHome({}, '/home/u')).toBe('/home/u/.agent-peers')
  })

  it('expands ~ only at the start', () => {
    expect(expandHome('~', '/h')).toBe('/h')
    expect(expandHome('~/a', '/h')).toBe('/h/a')
    expect(expandHome('a/~', '/h')).toBe('a/~')
  })

  it('lays out the home', () => {
    const p = peersPaths('/r')
    expect(p.config).toBe('/r/config.json')
    expect(p.credentials).toBe('/r/credentials.json')
    expect(p.autojoin).toBe('/r/autojoin.json')
    expect(p.run).toBe('/r/run')
    expect(socketPathFor('/r/run', 42)).toBe('/r/run/42.sock')
    expect(infoPathFor('/r/run', 42)).toBe('/r/run/42.json')
  })

  it('parses run file names', () => {
    expect(pidFromRunFile('123.json', '.json')).toBe(123)
    expect(pidFromRunFile('123.sock', '.sock')).toBe(123)
    expect(pidFromRunFile('0.json', '.json')).toBeUndefined()
    expect(pidFromRunFile('abc.json', '.json')).toBeUndefined()
    expect(pidFromRunFile('123.sock', '.json')).toBeUndefined()
  })

  it('normalizes hub origins', () => {
    expect(hubOrigin('wss://hub.example.com/v0/ws')).toBe('https://hub.example.com')
    expect(hubOrigin('ws://10.0.0.2:7337')).toBe('http://10.0.0.2:7337')
    expect(hubOrigin('https://hub.example.com/j/CODE')).toBe('https://hub.example.com')
  })
})

describe('LocalHome', () => {
  let root: string
  let home: LocalHome

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'peers-home-'))
    home = new LocalHome({ root: join(root, 'home'), userHome: root, now: () => 1234 })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('resolves its root from env when none is given', () => {
    const h = new LocalHome({ env: { AGENT_PEERS_HOME: '/tmp/x' }, userHome: '/u' })
    expect(h.paths.root).toBe('/tmp/x')
  })

  it('creates private directories', async () => {
    await home.ensure()
    expect(await mode(home.paths.root)).toBe(0o700)
    expect(await mode(home.paths.run)).toBe(0o700)
    expect(await mode(home.paths.inbox)).toBe(0o700)
  })

  it('returns defaults when config.json is missing or empty', async () => {
    const config = await home.readConfig()
    expect(config.reply_fallback).toBe('auto')
    expect(config.injection.peer_turns_per_hour).toBe(DEFAULT_PEER_TURNS_PER_HOUR)
    expect(config.peer_turn.allow_tools).toContain('Read')
    expect(config.peer_turn.deny_globs).toContain('.env*')
    expect(config.workspace.share).toBe('name')
    expect(defaultLocalConfig()).toEqual(config)
    await home.ensure()
    await writeFile(home.paths.config, '  \n')
    expect((await home.readConfig()).inline_wait_ms).toBe(45_000)
  })

  it('writes config 0600 atomically and keeps unknown keys', async () => {
    await home.writeConfig({ default_hub: 'https://hub.example.com', handle: 'work', future_key: 1 })
    expect(await mode(home.paths.config)).toBe(0o600)
    expect(await mode(home.paths.root)).toBe(0o700)
    const updated = await home.updateConfig((c) => ({ ...c, reply_fallback: 'nudge' }))
    expect(updated.reply_fallback).toBe('nudge')
    const raw = JSON.parse(await readFile(home.paths.config, 'utf8'))
    expect(raw.future_key).toBe(1)
    expect(raw.handle).toBe('work')
    expect((await readdir(home.paths.root)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('rejects malformed and invalid config with invalid_params', async () => {
    await home.ensure()
    await writeFile(home.paths.config, '{nope')
    expect(await errorCode(home.readConfig())).toBe('invalid_params')
    await writeFile(home.paths.config, JSON.stringify({ reply_fallback: 'sometimes' }))
    await expect(home.readConfig()).rejects.toThrow(/config.json is invalid: reply_fallback/)
    expect(await errorCode(home.writeConfig({ handle: 'Bad Handle!' }))).toBe('invalid_params')
  })

  it('stores credentials per hub origin', async () => {
    expect(await home.credentialFor('https://hub.example.com')).toBeUndefined()
    await home.setCredential('wss://hub.example.com/v0/ws', { member_token: 'tok-1', member: 'alice' })
    await home.setCredential('https://other.example.com', { member_token: 'tok-2' })
    expect(await mode(home.paths.credentials)).toBe(0o600)
    expect(await home.credentialFor('https://hub.example.com/j/x')).toEqual({
      member_token: 'tok-1',
      member: 'alice',
      saved_at: 1234,
    })
    const after = await home.removeCredential('https://hub.example.com')
    expect(Object.keys(after.hubs)).toEqual(['https://other.example.com'])
  })

  it('serializes concurrent read-modify-write cycles', async () => {
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((n) =>
        home.setCredential(`https://${n}.example.com`, { member_token: `t-${n}` }),
      ),
    )
    expect(Object.keys((await home.readCredentials()).hubs)).toHaveLength(4)
  })

  it('remembers, finds and forgets autojoin entries', async () => {
    const entry = {
      hub: 'wss://hub.example.com',
      room_id: 'room1',
      handle: 'api',
      agent: 'claude-code' as const,
      workspace: '/src/api',
      scope: 'workspace' as const,
    }
    await home.rememberAutojoin(entry)
    await home.rememberAutojoin({ ...entry, handle: 'api2' })
    await home.rememberAutojoin({ ...entry, room_id: 'room2', scope: 'session', local_key: 'k1' })
    const all = await home.readAutojoin()
    expect(all).toHaveLength(2)
    expect(all[0]?.hub).toBe('https://hub.example.com')
    expect(all[0]?.handle).toBe('api2')
    expect(await mode(home.paths.autojoin)).toBe(0o600)
    expect((await home.findAutojoin({ workspace: '/src/api' })).map((e) => e.room_id)).toEqual(['room1'])
    expect((await home.findAutojoin({ local_key: 'k1' })).map((e) => e.room_id)).toEqual(['room2'])
    await home.forgetAutojoin({ hub: 'https://hub.example.com', room_id: 'room1' })
    expect((await home.readAutojoin()).map((e) => e.room_id)).toEqual(['room2'])
  })

  it('lists and removes run files', async () => {
    await home.ensure()
    expect(await home.runPids()).toEqual([])
    await writeFile(join(home.paths.run, '20.json'), '{}')
    await writeFile(join(home.paths.run, '20.sock'), '')
    await writeFile(join(home.paths.run, '7.sock'), '')
    await writeFile(join(home.paths.run, 'junk.txt'), '')
    expect(await home.runPids()).toEqual([7, 20])
    await home.removeRunFiles(20)
    expect(await home.runPids()).toEqual([7])
    expect(await listRunPids(join(root, 'missing'))).toEqual([])
  })
})

describe('fs helpers', () => {
  it('maps unreadable paths to internal errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'peers-fs-'))
    try {
      await mkdir(join(dir, 'sub'))
      expect(await errorCode(readTextIfExists(join(dir, 'sub')))).toBe('internal')
      expect(await readTextIfExists(join(dir, 'none'))).toBeUndefined()
      expect(await errorCode(writeJsonFile(join(dir, 'sub'), LocalConfigSchema, {}))).toBe('internal')
      expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
