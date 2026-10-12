import { describe, expect, it } from 'bun:test'
import type { ProcessTree } from '@agent-peers/core'
import { PeersError } from '@agent-peers/protocol'
import type { AgentDetection } from '../../src/agents/types'
import {
  buildCard,
  helloMessageId,
  helloText,
  normalizeRemote,
  readGitInfo,
  shortHost,
  workspaceFields,
  workspaceSlug,
} from '../../src/join/card'
import { agentSessionKey, codexAncestorBinary, withRunningBinary } from '../../src/join/detect'
import { describeFailure, isSandboxFailure } from '../../src/join/errors'
import { commandLines, finishBlock, finishText, NO_AGENT_FINISH, rosterLines } from '../../src/join/finish'
import {
  assertHttpAllowed,
  fetchPreview,
  NetworkError,
  parsePreview,
  parseRedeem,
  redeemAsNewMember,
} from '../../src/join/hub-http'
import { installStep } from '../../src/join/install-step'
import { HandleTakenError } from '../../src/join/membership'
import { describeOrigin, emphasiseOrigin, registrableDomain } from '../../src/join/origin'
import { previewLines } from '../../src/join/preview'
import { parseTarget } from '../../src/join/render'
import { sandboxReport } from '../../src/join/sandbox'
import { pickHub } from '../../src/join/shell'

describe('origin display', () => {
  it('finds the registrable domain', () => {
    expect(registrableDomain('hub.example.com')).toBe('example.com')
    expect(registrableDomain('a.b.payments.example.co.uk')).toBe('example.co.uk')
    expect(registrableDomain('box.tail1234.ts.net')).toBe('tail1234.ts.net')
    expect(registrableDomain('localhost')).toBe('localhost')
    expect(registrableDomain('10.0.0.5')).toBe('10.0.0.5')
  })

  it('emphasises it, shows IDNs as punycode and flags private hosts', () => {
    const idn = describeOrigin('https://hub.bücher.example:8443/x?y')
    expect(idn.punycode).toBe(true)
    expect(emphasiseOrigin(idn)).toBe('https://hub.[XN--BCHER-KVA.EXAMPLE]:8443')
    expect(emphasiseOrigin(describeOrigin('https://example.com'))).toBe('https://[EXAMPLE.COM]')
    expect(emphasiseOrigin(describeOrigin('http://[::1]:7337'))).toBe('http://[::1]:7337')
    expect(describeOrigin('http://192.168.1.4:7337').local).toBe(true)
    const lines = previewLines({
      origin: 'https://hub.bücher.example',
      preview: {
        hub_name: 'x',
        room: { room_id: 'r1', name: 'team', display_name: 'Team `$(rm)`' },
        inviter: 'al<b>',
      },
      credential: undefined,
      memberName: 'bob',
      handle: { name: 'bob', fixed: true },
      kind: 'codex',
      card: { agent: { kind: 'codex' }, host: 'h' },
      workspace: { name: 'api', git_remote: 'github.com/a/api', branch: 'main' },
    })
    expect(lines[0]).toBe(`room "Team (rm)" (#team), invited by @alb`)
    expect(lines.join('\n')).toContain('internationalised domain shown as punycode')
    expect(lines.join('\n')).toContain('remote github.com/a/api · branch main')
  })
})

describe('card', () => {
  it('builds host, workspace fields, hello text and ids', async () => {
    expect(shortHost('gulei-mbp.local')).toBe('gulei-mbp')
    expect(shortHost('...')).toBe('host')
    expect(normalizeRemote('https://user:tok@github.com/acme/api.git')).toBe('github.com/acme/api')
    expect(normalizeRemote('file:///x')).toBeUndefined()
    expect(normalizeRemote('not a url')).toBeUndefined()
    expect(await readGitInfo('/nonexistent/dir')).toEqual({})
    expect(workspaceFields('none', '/x/api', {})).toBeUndefined()
    expect(workspaceFields('full', '/x/api', { remote: 'r', branch: 'b' })).toEqual({
      name: 'api',
      git_remote: 'r',
      branch: 'b',
    })
    expect(workspaceSlug('/x/支付')).toMatch(/^agent-[a-z0-9]+$/)
    expect(helloText('h', 'codex', undefined)).toBe('hello from @h — codex')
    expect(helloText('h', 'codex', { name: 'api', branch: 'main' })).toBe('hello from @h — codex · api@main')
    expect(helloMessageId('bob', 'r1')).toBe(helloMessageId('bob', 'r1'))
    expect(helloMessageId('bob', 'r1')).not.toBe(helloMessageId('bob', 'r2'))
    const card = buildCard({
      kind: 'codex',
      host: 'h',
      adapter: '0.1.0',
      agentVersion: '1.0',
      model: 'm\nx',
      summary: 's',
    })
    expect(card).toMatchObject({ model: 'm x', summary: 's', agent: { version: '1.0' } })
  })
})

describe('detection helpers', () => {
  const tree: ProcessTree = {
    lookup: async (pid) =>
      ({
        [process.pid]: { ppid: 4343, comm: 'bun' },
        4343: { ppid: 4242, comm: '/bin/zsh' },
        4242: { ppid: 1, comm: '/opt/codex/bin/codex' },
      })[pid],
    isAlive: () => true,
  }

  it('finds the running codex binary among the ancestors', async () => {
    expect(await codexAncestorBinary(tree, process.pid)).toBe('/opt/codex/bin/codex')
    const detection = { id: 'codex', evidence: [] } as unknown as AgentDetection
    const running = {
      path: '/opt/codex/bin/codex',
      realPath: '/opt/codex/bin/codex',
      version: '0.160.1',
      source: 'running codex process',
    }
    expect(withRunningBinary(detection, running).binary?.source).toBe('running codex process')
    expect(withRunningBinary(detection, undefined)).toBe(detection)
    const claude = { id: 'claude-code', evidence: [] } as unknown as AgentDetection
    expect(withRunningBinary(claude, running)).toBe(claude)
  })

  it('derives the agent session key', () => {
    const base = {
      explicit: [],
      here: false,
      yes: false,
      detections: [],
      interactive: false,
      previous: [],
      host: 'h',
    }
    expect(agentSessionKey({ ...base, sessionKey: 'k', env: {} }, 'codex')).toBe('k')
    expect(agentSessionKey({ ...base, env: {} }, 'claude-desktop')).toBe('claude-desktop@h')
    const pi = { name: 'pi', sandboxed: false }
    expect(agentSessionKey({ ...base, current: pi, env: { PI_SESSION_ID: 'p1' } }, 'other')).toBe('p1')
    const codex = { name: 'codex', id: 'codex' as const, sessionKey: 't', sandboxed: false }
    expect(agentSessionKey({ ...base, current: codex, env: {} }, 'codex-desktop')).toBe('t')
    expect(agentSessionKey({ ...base, current: codex, env: {} }, 'claude-code')).toBeUndefined()
  })
})

describe('errors', () => {
  it('describes failures with exit codes', () => {
    expect(describeFailure(new Error('boom'))).toEqual({ code: 1, lines: ['agent-peers: boom'] })
    expect(describeFailure('weird').lines[0]).toBe('agent-peers: weird')
    expect(describeFailure(new NetworkError('cannot reach x', undefined)).code).toBe(4)
    expect(describeFailure(new PeersError('forbidden', 'kicked')).lines[0]).toBe(
      'agent-peers: the hub refused: kicked',
    )
    expect(describeFailure(new PeersError('target_busy', 'busy')).lines[0]).toBe(
      'agent-peers: busy [target_busy]',
    )
    expect(describeFailure(new PeersError('unauthorized', 'x')).code).toBe(5)
    expect(describeFailure(new HandleTakenError('a', undefined)).lines[1]).toBe(
      'Rerun with a different handle.',
    )
  })

  it('recognises sandbox-shaped failures', () => {
    expect(isSandboxFailure(new NetworkError('x', 'ENOTFOUND'))).toBe(true)
    expect(isSandboxFailure(new NetworkError('x', 'ConnectionRefused'))).toBe(false)
    expect(isSandboxFailure(new PeersError('internal', 'x', undefined, { cause: { code: 'EACCES' } }))).toBe(
      true,
    )
    expect(isSandboxFailure(null)).toBe(false)
    const report = sandboxReport('r', { origin: 'https://h', args: ['join', "it's"], terminalArgs: ['join'] })
    expect(report.code).toBe(3)
    expect(report.lines[3]).toBe(`  curl -fsSL https://h/install.sh | sh -s -- join 'it'\\''s'`)
    expect(report.lines[5]).toBe('  curl -fsSL https://h/install.sh | sh -s -- join')
  })
})

describe('finish', () => {
  it('has the CLI own text for every agent', () => {
    expect(finishText('cursor', undefined)).toContain('Developer: Reload Window')
    expect(finishText('pi', undefined)).toBe('type /reload')
    expect(finishText('opencode', undefined)).toBe('restart opencode (opencode -c)')
    expect(finishText('other', undefined)).toBe(NO_AGENT_FINISH)
    expect(finishText('claude-code', 'skills-dir')).toContain('start a new Claude Code session')
    expect(finishBlock([], {}, undefined)).toEqual(['', '[agent-peers] FINISH:', `  ${NO_AGENT_FINISH}`])
    expect(commandLines('cursor', 'x')[0]).toBe('ask: /peers-ask @x <question> · who: /peers-who')
    expect(commandLines('other', 'x')).toHaveLength(1)
    expect(rosterLines([], 'me')).toEqual(['nobody is here yet'])
  })
})

describe('hub http', () => {
  it('validates preview and redeem bodies', () => {
    expect(parsePreview(null)).toBeUndefined()
    expect(parsePreview({ hub_name: 'h', room: { room_id: 'r', name: 'BAD' }, inviter: 'a' })).toBeUndefined()
    expect(
      parsePreview({ hub_name: 'h', room: { room_id: 'r', name: 'ok' }, inviter: 'a', description: 'd' }),
    ).toEqual({
      hub_name: 'h',
      room: { room_id: 'r', name: 'ok' },
      inviter: 'a',
      description: 'd',
    })
    expect(
      parseRedeem({ member_token: 't', member: { name: 'Bad' }, grant: { room_id: 'r' } }),
    ).toBeUndefined()
    expect(parseRedeem([])).toBeUndefined()
  })

  it('refuses redirects, maps errors and enforces the transport rule', async () => {
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://evil' } })
    await expect(fetchPreview(redirect, 'https://h', 'CODE')).rejects.toMatchObject({
      code: 'invite_invalid',
    })
    const html = async () => new Response('<html>', { status: 500 })
    await expect(fetchPreview(html, 'https://h', 'CODE')).rejects.toMatchObject({ code: 'internal' })
    const junk = async () => Response.json({ nope: true })
    await expect(fetchPreview(junk, 'https://h', 'CODE')).rejects.toMatchObject({ code: 'invalid_result' })
    await expect(redeemAsNewMember(junk, 'https://h', 'CODE', 'bob')).rejects.toMatchObject({
      code: 'invalid_result',
    })
    const down = async () => {
      throw Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' })
    }
    await expect(fetchPreview(down, 'https://h', 'CODE')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(() => assertHttpAllowed('http://hub.example.com', false)).toThrow('refusing plain http://')
    expect(() => assertHttpAllowed('http://hub.example.com', true)).not.toThrow()
  })
})

describe('shell helpers', () => {
  it('parses targets and picks the hub', () => {
    expect(parseTarget('@work')).toEqual({ handle: 'work' })
    expect(parseTarget('work@team')).toEqual({ handle: 'work', room: 'team' })
    expect(parseTarget('@Work')).toBeUndefined()
    const config = { default_hub: 'https://b.example' } as Parameters<typeof pickHub>[1]
    const two = {
      hubs: { 'https://a.example': { member_token: 't' }, 'https://b.example': { member_token: 'u' } },
    }
    expect(pickHub(two, config, undefined)).toBe('https://b.example')
    expect(() => pickHub(two, {} as typeof config, undefined)).toThrow('several hubs')
    expect(pickHub(two, config, 'https://a.example/j/x')).toBe('https://a.example')
    expect(() => pickHub(two, config, 'https://c.example')).toThrow('no member token')
    expect(() => pickHub({ hubs: {} }, config, undefined)).toThrow('not a member of any hub')
  })

  it('install step with no agents is a no-op', async () => {
    const result = await installStep({
      ids: [],
      detections: [],
      sys: {} as Parameters<typeof installStep>[0]['sys'],
      home: '/x',
      version: '0.1.0',
      source: undefined,
    })
    expect(result).toMatchObject({ ok: true, alreadyInstalled: false })
  })
})
