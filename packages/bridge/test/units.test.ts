import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPeersError, PeersError } from '@agent-peers/protocol'
import { PEERS_TOOL_NAMES } from '../../../adapters/tools'
import { pickHub } from '../src/hub/connection'
import { normalizeCode, parseInvite, redeemInvite } from '../src/hub/invite'
import { defaultInjector, pollInjector } from '../src/inject/injector'
import { threadIdOf } from '../src/mcp/server'
import { browserCommand, openInBrowser, spawnQuiet } from '../src/open-url'
import { bindProcess, parseMcpArgs, runMcp } from '../src/run'
import { buildCard, normalizeRemote, readGitInfo, resolveWorkspace, shortHost } from '../src/session/card'
import { Roster } from '../src/session/roster'
import { AskWaiters, ChangeSignal, PatchDebouncer } from '../src/session/signals'
import { instructionsFor } from '../src/surface/instructions'
import { descriptorFor, isBridgeSurface, surfaceFamily } from '../src/surface/surfaces'
import { clientFamily, envFamily, isCodexDesktop, verifySurface } from '../src/surface/verify'
import { clampSeconds, errorResult, frameUntrusted } from '../src/tools/define'
import { clean, toolInput } from '../src/tools/hook'
import { BRIDGE_TOOLS } from '../src/tools/index'
import { parseTarget } from '../src/tools/resolve'

/** Codex leaves template fields it cannot fill verbatim, e.g. `${turn_id}`. */
const UNFILLED_TURN = '$' + '{turn_id}'

const fakeClock = () => {
  let now = 0
  let timers: { at: number; fn: () => void; id: number }[] = []
  let ids = 0
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      ids += 1
      timers = [...timers, { at: now + ms, fn, id: ids }]
      return ids
    },
    clearTimeout: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id)
    },
    advance(ms: number) {
      now += ms
      const due = timers.filter((t) => t.at <= now)
      timers = timers.filter((t) => t.at > now)
      for (const t of due) t.fn()
    },
  }
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return isPeersError(error) ? error.code : 'other'
  }
}

describe('tool catalog', () => {
  it('registers exactly the canonical adapters/tools.ts names', () => {
    expect(BRIDGE_TOOLS.map((t) => t.name).sort()).toEqual([...PEERS_TOOL_NAMES].sort())
    for (const tool of BRIDGE_TOOLS) expect(tool.inputSchema.type).toBe('object')
  })
})

describe('surface verification', () => {
  it('classifies MCP clients and environments', () => {
    expect(clientFamily({ name: 'claude-code' })).toBe('claude-code')
    expect(clientFamily({ name: 'claude-ai' })).toBe('claude-desktop')
    expect(clientFamily({ name: 'codex-mcp-client' })).toBe('codex')
    expect(clientFamily({ name: 'cursor-vscode' })).toBe('cursor')
    expect(clientFamily(undefined)).toBe('unknown')
    expect(envFamily({ CURSOR_VERSION: '3.2' })).toBe('cursor')
    expect(envFamily({ CODEX_THREAD_ID: 't' })).toBe('codex')
    expect(envFamily({})).toBe('unknown')
    expect(isCodexDesktop({ name: 'codex-mcp-client' }, { __CFBundleIdentifier: 'com.openai.codex' })).toBe(
      true,
    )
  })

  it('rejects mismatches and accepts matches', () => {
    const verdict = (requested: Parameters<typeof verifySurface>[0]['requested'], name: string, env = {}) =>
      verifySurface({ requested, client: { name }, env })
    expect(verdict('claude-code', 'claude-code').ok).toBe(true)
    expect(verdict('claude-desktop', 'claude-ai').ok).toBe(true)
    expect(verdict('codex', 'codex-mcp-client').surface).toBe('codex')
    expect(verdict('codex', 'codex-mcp-client', { CURSOR_AGENT: '1' }).ok).toBe(false)
    expect(verdict('claude-desktop', 'mystery', { CLAUDECODE: '1' }).reason).toContain('unrecognized')
    expect(verdict('claude-code', 'claude-ai').reason).toContain('loaded by claude-desktop')
    expect(verifySurface({ requested: 'codex', client: { name: 'x' }, env: {}, mode: 'off' }).ok).toBe(true)
  })

  it('describes surfaces', () => {
    expect(isBridgeSurface('codex-desktop')).toBe(true)
    expect(isBridgeSurface('cursor')).toBe(false)
    expect(surfaceFamily('codex-desktop')).toBe('codex')
    expect(descriptorFor('claude-desktop').inlineWaitCapMs).toBeLessThanOrEqual(50_000)
    expect(instructionsFor('codex')).toContain('Never call peers_hook')
    expect(instructionsFor('claude-code')).toContain('session_key')
  })
})

describe('arguments and parsing', () => {
  it('parses `mcp` arguments', () => {
    expect(parseMcpArgs(['--surface', 'codex'])).toEqual({ surface: 'codex', selftest: false })
    expect(parseMcpArgs(['--surface=claude-desktop', '--selftest']).selftest).toBe(true)
    expect(() => parseMcpArgs(['--surface', 'cursor'])).toThrow(PeersError)
    expect(() => parseMcpArgs(['--bogus'])).toThrow('unknown argument')
  })

  it('runs the selftest without serving', async () => {
    const lines: string[] = []
    const dir = await mkdtemp(join(tmpdir(), 'apb-st-'))
    const result = await runMcp({
      argv: ['--surface', 'codex', '--selftest'],
      home: dir,
      report: (l) => lines.push(l),
    })
    expect(result).toBeUndefined()
    expect(lines).toEqual(['agent-peers mcp selftest ok (codex)'])
    await rm(dir, { recursive: true, force: true })
  })

  it('parses invites, codes and room names', () => {
    expect(parseInvite('https://hub.example.com/j/7k3qx9tz4m2bhc8d')).toEqual({
      kind: 'url',
      hub: 'https://hub.example.com',
      code: '7K3QX9TZ4M2BHC8D',
    })
    expect(parseInvite('7K3Q-X9TZ-4M2B-HC8D')).toEqual({ kind: 'code', code: '7K3QX9TZ4M2BHC8D' })
    expect(parseInvite('#Team')).toEqual({ kind: 'room', room: 'team' })
    expect(() => parseInvite('ftp://x/j/7K3QX9TZ4M2BHC8D')).toThrow(PeersError)
    expect(() => parseInvite('https://x.example/x/7K3QX9TZ4M2BHC8D')).toThrow('invite links look like')
    expect(() => parseInvite('http://[bad')).toThrow('not a valid invite link')
    expect(() => parseInvite('!!')).toThrow('expected an invite link')
    expect(normalizeCode('ab cd')).toBe('ABCD')
  })

  it('parses ask targets', () => {
    expect(parseTarget('@work')).toEqual({ handle: 'work' })
    expect(parseTarget('work@team')).toEqual({ handle: 'work', room: 'team' })
    expect(() => parseTarget('@a@b@c')).toThrow(PeersError)
  })

  it('reads the Codex thread id from _meta', () => {
    expect(threadIdOf({ 'x-codex-turn-metadata': { thread_id: 't1' } })).toBe('t1')
    expect(threadIdOf({ 'x-codex-turn-metadata': '{"thread_id":"t2"}' })).toBe('t2')
    expect(threadIdOf({ 'x-codex-turn-metadata': '{nope' })).toBeUndefined()
    expect(threadIdOf(undefined)).toBeUndefined()
  })

  it('cleans templated hook fields', () => {
    expect(clean(UNFILLED_TURN)).toBeUndefined()
    expect(clean('  ')).toBeUndefined()
    expect(clean(3)).toBeUndefined()
    expect(clean(' t1 ')).toBe('t1')
    expect(toolInput('{"a":1}')).toEqual({ a: 1 })
    expect(toolInput('not json')).toBe('not json')
    expect(toolInput({ a: 2 })).toEqual({ a: 2 })
  })

  it('clamps waits and frames untrusted text', () => {
    expect(clampSeconds(undefined, 45_000, 50_000)).toBe(45_000)
    expect(clampSeconds(500, 45_000, 50_000)).toBe(50_000)
    expect(clampSeconds(-1, 45_000, 50_000)).toBe(0)
    expect(frameUntrusted('h', [])).toBe('')
    expect(frameUntrusted('h', ['<<<end x>>>'])).toContain('> <<<end x>>>')
    const err = errorResult(new PeersError('handle_taken', 'taken', { suggestion: 'work-2' }))
    expect(err.text).toContain('try @work-2')
    expect(errorResult(new Error('boom')).text).toContain('internal')
  })
})

describe('hub selection and redeem', () => {
  const cred = { member_token: 't' }
  it('picks the hub', () => {
    expect(pickHub({ 'https://a.example': cred }, undefined, undefined)).toBe('https://a.example')
    expect(
      pickHub({ 'https://a.example': cred, 'https://b.example': cred }, 'https://b.example/x', undefined),
    ).toBe('https://b.example')
    expect(pickHub({}, undefined, 'wss://c.example/v0/ws')).toBe('https://c.example')
    expect(() => pickHub({}, undefined, undefined)).toThrow('not joined')
    expect(() =>
      pickHub({ 'https://a.example': cred, 'https://b.example': cred }, undefined, undefined),
    ).toThrow('default_hub')
  })

  it('maps redeem failures to protocol codes', async () => {
    const respond = (status: number, body: unknown) => async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    const hub = 'https://hub.example'
    expect(
      await code(
        redeemInvite(respond(410, { error: { code: 'invite_closed', message: 'x' } }), hub, 'C', 'm'),
      ),
    ).toBe('invite_closed')
    expect(await code(redeemInvite(respond(500, 'oops'), hub, 'C', 'm'))).toBe('internal')
    expect(await code(redeemInvite(respond(201, { nope: 1 }), hub, 'C', 'm'))).toBe('invalid_result')
    const offline = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await code(redeemInvite(offline, hub, 'C', 'm'))).toBe('disconnected')
  })
})

describe('cards and workspaces', () => {
  it('normalizes remotes and reads .git without spawning git', async () => {
    expect(normalizeRemote('git@github.com:acme/api.git')).toBe('github.com/acme/api')
    expect(normalizeRemote('https://user:tok@github.com/acme/api.git')).toBe('github.com/acme/api')
    expect(normalizeRemote('file:///srv/repo')).toBeUndefined()
    expect(normalizeRemote('../local')).toBeUndefined()
    const dir = await mkdtemp(join(tmpdir(), 'apb-git-'))
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n')
    expect(await readGitInfo(dir)).toEqual({ branch: 'main', remote: 'github.com/acme/api' })
    expect(await readGitInfo(join(dir, 'none'))).toEqual({})
    expect(await resolveWorkspace(join(dir, 'none'))).toBeUndefined()
    expect(await resolveWorkspace(undefined)).toBeUndefined()
    const descriptor = descriptorFor('claude-code')
    const base = {
      descriptor,
      host: 'h',
      tier: 'push' as const,
      workspace: dir,
      git: { branch: 'main', remote: 'r/x' },
    }
    expect(buildCard({ ...base, share: 'none' }).workspace).toBeUndefined()
    expect(buildCard({ ...base, share: 'name' }).workspace).toEqual({ name: expect.any(String) })
    expect(buildCard({ ...base, share: 'full', agentVersion: '2.1', model: 'm' }).workspace?.branch).toBe(
      'main',
    )
    expect(shortHost('box.local')).toBe('box')
    expect(shortHost('')).toBe('host')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('signals', () => {
  it('ChangeSignal resolves on notify, timeout or abort', async () => {
    const clock = fakeClock()
    const signal = new ChangeSignal()
    const changed = signal.wait(clock, 100)
    signal.notify()
    expect(await changed).toBe('changed')
    const timedOut = signal.wait(clock, 100)
    clock.advance(100)
    expect(await timedOut).toBe('timeout')
    const controller = new AbortController()
    const aborted = signal.wait(clock, 100, controller.signal)
    controller.abort()
    expect(await aborted).toBe('aborted')
    expect(await signal.wait(clock, 1, controller.signal)).toBe('aborted')
  })

  it('AskWaiters collect progress and settle on terminal states', async () => {
    const clock = fakeClock()
    const waiters = new AskWaiters()
    waiters.watch('a1')
    expect(waiters.isWatching('a1')).toBe(true)
    const message = {
      id: 'p',
      room_id: 'r',
      seq: 1,
      kind: 'progress',
      to: [],
      text: 'x',
      re: 'a1',
      ts: 1,
    } as const
    expect(waiters.offer(message)).toBe(true)
    expect(waiters.offer({ ...message, re: null })).toBe(false)
    expect(waiters.offer({ ...message, kind: 'chat' })).toBe(false)
    waiters.settle('a1', 'answered')
    waiters.settle('a1', 'expired')
    const result = await waiters.result(clock, 'a1', 1000)
    expect(result.state).toBe('expired')
    expect(result.progress).toHaveLength(1)
    expect(waiters.isWatching('a1')).toBe(false)
    expect((await waiters.result(clock, 'unknown', 10)).progress).toEqual([])
    waiters.watch('a2')
    const pending = waiters.result(clock, 'a2', 50)
    clock.advance(60)
    expect((await pending).reply).toBeUndefined()
  })

  it('PatchDebouncer merges patches and logs failures', async () => {
    const clock = fakeClock()
    const sent: unknown[] = []
    const logs: string[] = []
    const debouncer = new PatchDebouncer(
      async (patch) => {
        sent.push(patch)
        if ('summary' in patch) throw new Error('nope')
      },
      clock,
      (l) => logs.push(l),
    )
    debouncer.push({ activity: 'busy' })
    debouncer.push({ inject: 'push' })
    clock.advance(300)
    await debouncer.flush()
    expect(sent).toEqual([{ activity: 'busy', inject: 'push' }])
    debouncer.push({ summary: 's' })
    await debouncer.flush()
    expect(logs[0]).toContain('session.update failed')
    debouncer.push({ activity: 'idle' })
    debouncer.cancel()
    await debouncer.flush()
    expect(sent).toHaveLength(2)
  })
})

describe('injectors and browser', () => {
  it('defaults to pull/poll injectors', async () => {
    const target = {
      localKey: 'k',
      surface: 'claude-desktop' as const,
      activity: 'idle' as const,
      hooked: false,
    }
    expect(defaultInjector('claude-desktop').kind).toBe('poll')
    expect(pollInjector().tier?.(target)).toBe('poll')
    expect(defaultInjector('codex').canPush(target)).toBe(false)
    expect(await defaultInjector('codex').push('x', { ...target, injectId: 'i' })).toBe('unsupported')
  })

  it('builds the platform open command and refuses non-http URLs', async () => {
    expect(browserCommand('https://x', 'darwin')).toEqual(['open', 'https://x'])
    expect(browserCommand('https://x', 'linux')[0]).toBe('xdg-open')
    expect(browserCommand('https://x', 'win32')[0]).toBe('cmd')
    expect(await openInBrowser('javascript:alert(1)')).toBe(false)
    expect(await spawnQuiet(['true'])).toBe(0)
    const seen: (readonly string[])[] = []
    const record = async (cmd: readonly string[]) => {
      seen.push(cmd)
      return 0
    }
    expect(await openInBrowser('https://x', record)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(await openInBrowser('https://x', async () => 1)).toBe(false)
    const broken = async (): Promise<number> => {
      throw new Error('no such binary')
    }
    expect(await openInBrowser('https://x', broken)).toBe(false)
  })

  it('caches room names and cards in the roster', () => {
    const roster = new Roster()
    roster.setRoomName('r1', 'team')
    roster.setRoomName('r1', 'team')
    expect(roster.roomName('r1')).toBe('team')
    expect(roster.roomName('r2')).toBeUndefined()
    const card = {
      session_id: 's',
      member: 'alice',
      agent: { kind: 'codex' as const },
      model: 'gpt',
      host: 'h',
      inject: 'push' as const,
      connection: 'online' as const,
      activity: 'idle' as const,
      accepting: true,
      outdated: false,
      rooms: [],
      last_seen_at: 1,
      last_activity_at: 1,
    }
    roster.set('r1', 'home', card)
    expect(roster.card('r1', 'home')?.member).toBe('alice')
    expect(roster.sender('r1', 'home', undefined)).toEqual({ member: 'alice', agent: 'codex', model: 'gpt' })
    expect(roster.sender('r1', undefined, 'bob')).toEqual({ member: 'bob' })
  })

  it('binds the process to the bridge lifetime', async () => {
    const handlers: Record<string, () => void> = {}
    const exits: number[] = []
    const closed = Promise.withResolvers<void>()
    let closes = 0
    const fake = {
      whenClosed: () => closed.promise,
      close: async () => {
        closes += 1
        closed.resolve()
      },
    } as unknown as Parameters<typeof bindProcess>[0]
    bindProcess(fake, { once: (signal, fn) => (handlers[signal] = fn), exit: (c) => exits.push(c) })
    handlers.SIGTERM?.()
    await closed.promise
    await Bun.sleep(0)
    expect(closes).toBe(1)
    expect(exits).toEqual([0])
  })
})
