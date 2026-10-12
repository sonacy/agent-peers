import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { readInstallState } from '../../src/install/state'
import { runJoin } from '../../src/join/run'
import { installFakeClaude } from '../helpers/fake-agents'
import { type JoinWorld, output, roomTexts, startJoinWorld } from '../helpers/join-world'

let w: JoinWorld
beforeEach(async () => {
  w = await startJoinWorld()
  await installFakeClaude(w.m)
})
afterEach(async () => {
  await w.stop()
})

const CLAUDE: Record<string, string> = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }

async function join(options: Parameters<typeof runJoin>[1] = { here: true }, env = CLAUDE, extra = {}) {
  const io = w.io(env)
  const code = await runJoin(w.inviteUrl, options, io, w.deps(extra))
  return { code, ...output(io) }
}

const hellos = async () => (await roomTexts(w)).filter((text) => text.startsWith('hello from'))

describe('agent-peers join: preview', () => {
  it('--dry-run prints the preview and changes nothing', async () => {
    const result = await join({ here: true, dryRun: true })
    expect(result.code).toBe(0)
    expect(result.out).toContain('[1/7] preview: room "Payments Team" (#payments), invited by @alice')
    expect(result.out).toContain('registrable domain 127.0.0.1')
    expect(result.out).toContain('member:   payments-api (new member on this hub)')
    expect(result.out).toContain(
      'handle @payments-api (or a free variant) · member payments-api · agent claude-code',
    )
    expect(result.out).toContain('dry run')
    expect(result.out).not.toContain('[2/7]')
    expect(await w.local.readCredentials()).toEqual({ hubs: {} })
    expect((await w.m.calls()).some((call) => call.includes('plugin'))).toBe(false)
    expect(await hellos()).toEqual([])
  })

  it('shows the --handle, --name and --summary it will publish', async () => {
    const result = await join({
      here: true,
      dryRun: true,
      handle: '@api',
      name: 'bob',
      summary: 'retry\npolicy',
    })
    expect(result.out).toContain('handle @api · member bob · agent claude-code')
    expect(result.out).toContain('summary "retry policy"')
  })

  it('a closed invite stops with a clear message', async () => {
    await w.alice.client.request('invite.close', { session_id: w.alice.session.sessionId, room_id: w.roomId })
    const result = await join()
    expect(result.code).toBe(1)
    expect(result.err).toContain('the owner closed invites to this room')
  })

  it('a rotated (expired) invite stops with a clear message', async () => {
    await w.alice.client.request('invite.rotate', {
      session_id: w.alice.session.sessionId,
      room_id: w.roomId,
    })
    const result = await join()
    expect(result.code).toBe(1)
    expect(result.err).toContain('invalid or was replaced')
    expect(await w.local.readCredentials()).toEqual({ hubs: {} })
  })

  it('usage errors exit 2', async () => {
    const io = w.io(CLAUDE)
    expect(await runJoin('https://example.com/not-an-invite', { here: true }, io, w.deps())).toBe(2)
    expect(output(io).err).toContain('is not an invite link')
    expect((await join({ here: true, handle: 'Not Valid' })).code).toBe(2)
    expect((await join({ here: true, name: 'BAD NAME' })).code).toBe(2)
    expect((await join({ here: true, agent: ['codex'] })).code).toBe(2)
    const outside = await join({ here: true }, {})
    expect(outside.code).toBe(2)
    expect(outside.err).toContain('--here')
  })

  it('an unreachable hub exits 4', async () => {
    const io = w.io(CLAUDE)
    const dead = 'http://127.0.0.1:9/j/7K3QX9TZ4M2BHC8D'
    expect(await runJoin(dead, { here: true }, io, w.deps())).toBe(4)
    expect(output(io).err).toContain('cannot reach 127.0.0.1:9')
  })
})

describe('agent-peers join: sandbox', () => {
  it('CODEX_SANDBOX stops with exit 3 before redeeming and prints both commands', async () => {
    const env = { CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: 'thread-9' }
    const result = await join({ here: true, handle: 'api' }, env)
    expect(result.code).toBe(3)
    expect(result.err).toContain("blocked by your agent's sandbox (CODEX_SANDBOX is set)")
    expect(result.err).toContain(`/install.sh | sh -s -- join ${w.inviteUrl} --here --handle api`)
    expect(result.err).toContain(`join ${w.inviteUrl} -a codex --session-key thread-9 --handle api`)
    expect(await w.local.readCredentials()).toEqual({ hubs: {} })
  })

  it('a sandboxed network (ENOTFOUND) inside an agent exits 3, at preview or at redeem', async () => {
    const lookupFails = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const offline = async () => {
      throw lookupFails
    }
    const atPreview = await join({ here: true }, CLAUDE, { fetch: offline })
    expect(atPreview.code).toBe(3)
    expect(atPreview.err).toContain(`join ${w.inviteUrl} -a claude-code`)
    const previewOnly = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw lookupFails
      return fetch(input, init)
    }
    const atRedeem = await join({ here: true }, CLAUDE, { fetch: previewOnly })
    expect(atRedeem.code).toBe(3)
    expect(atRedeem.err).toContain('--session-key cc-bob')
    expect(await w.local.readCredentials()).toEqual({ hubs: {} })
  })

  it('an unwritable home is reported as the sandbox (exit 3)', async () => {
    await mkdir(w.m.peersHome, { recursive: true })
    await chmod(w.m.peersHome, 0o500)
    try {
      const result = await join()
      expect(result.code).toBe(3)
      expect(result.err).toContain('cannot write to')
      expect(result.err).toContain('--session-key cc-bob')
    } finally {
      await chmod(w.m.peersHome, 0o700)
    }
  })
})

describe('agent-peers join: install, membership and hello', () => {
  it('redeems as a new member, installs, joins, says hello once and remembers the workspace', async () => {
    const result = await join()
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('[2/7] detect: Claude Code (--here (claude))')
    expect(result.out).toContain('session cc-bob')
    expect(result.out).toContain('[3/7] install: installed into Claude Code')
    expect(result.out).toContain('selftest claude-code: agent-peers mcp selftest ok')
    expect(result.out).toContain('[4/7] membership: redeemed the invite as new member payments-api')
    expect(result.out).toContain('[5/7] join: joined "Payments Team" as @payments-api · said hello')
    expect(result.out).toContain(`future sessions in ${w.workspace.replace(/^\/var/, '/private/var')}`)
    expect(result.out).toContain('@alice · claude-code · online')
    expect(result.out).toContain('ask: /peers:ask @alice <question> · who: /peers:who')
    expect(result.out.trimEnd().split('\n').slice(-2)).toEqual([
      '[agent-peers] FINISH:',
      '  Claude Code: type /reload-plugins --force, then send any message (e.g. /peers:who)',
    ])
    expect(await hellos()).toEqual(['hello from @payments-api — claude-code · payments-api'])
    const credentials = await w.local.readCredentials()
    expect(credentials.hubs[w.url]?.member).toBe('payments-api')
    const [entry] = await w.local.readAutojoin()
    expect(entry).toMatchObject({ hub: w.url, room_id: w.roomId, handle: 'payments-api', scope: 'workspace' })
    expect(entry?.local_key).toBe('cc-bob')
    expect(Object.keys(await readInstallState(w.m.peersHome))).toEqual(['claude-code'])
  })

  it('a rerun is idempotent: no invite use, no second member, no second hello', async () => {
    expect((await join()).code).toBe(0)
    const token = (await w.local.readCredentials()).hubs[w.url]?.member_token
    const again = await join()
    expect(again.code).toBe(0)
    expect(again.out).toContain('[3/7] install: already installed in Claude Code (0.1.0)')
    expect(again.out).toContain('[4/7] membership: already a member (no invite use)')
    expect(again.out).toContain('[5/7] join: already joined "Payments Team" as @payments-api')
    expect((await w.local.readCredentials()).hubs[w.url]?.member_token).toBe(token)
    expect(await hellos()).toHaveLength(1)
    expect(await w.local.readAutojoin()).toHaveLength(1)
  })

  it('an existing member joining from a new session reclaims the remembered handle without hello', async () => {
    expect((await join()).code).toBe(0)
    const other = await join({ here: true }, { ...CLAUDE, CLAUDE_CODE_SESSION_ID: 'cc-bob-2' })
    expect(other.code).toBe(0)
    expect(other.out).toContain('[4/7] membership: already a member as payments-api (no invite use)')
    expect(other.out).toContain('joined "Payments Team" as @payments-api')
    expect(other.out).not.toContain('said hello')
    expect(await hellos()).toHaveLength(1)
  })

  it('a token without a grant redeems with that token and says hello', async () => {
    const issued = w.hub.services.members.create('bob')
    await w.local.setCredential(w.url, { member_token: issued.token, member: 'bob' })
    const result = await join({ here: true, handle: 'api' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('member:   bob (already a member of this hub)')
    expect(result.out).toContain('[4/7] membership: redeemed the invite with your existing membership as bob')
    expect(await hellos()).toEqual(['hello from @api — claude-code · payments-api'])
  })

  it('a taken member name gets a suffix and the CLI says so', async () => {
    w.hub.services.members.create('payments-api')
    const result = await join()
    expect(result.code).toBe(0)
    expect(result.out).toContain('you are member payments-api-2 on this hub')
    expect((await w.local.readCredentials()).hubs[w.url]?.member).toBe('payments-api-2')
  })

  it('a derived handle taken by another member moves to a free variant', async () => {
    const carol = await w.member('carol')
    const code = w.inviteUrl.split('/').at(-1) ?? ''
    await carol.session.join({ invite_code: code, handle: 'payments-api' })
    const result = await join()
    expect(result.code).toBe(0)
    expect(result.out).toContain('@payments-api is taken in this room; using @payments-api-2')
    expect(result.out).toContain('as @payments-api-2')
  })

  it('an explicit handle is never suffixed: a taken one stops with a suggestion', async () => {
    const result = await join({ here: true, handle: 'alice' })
    expect(result.code).toBe(1)
    expect(result.err).toContain('@alice is already taken in this room')
    expect(result.err).toContain("--handle 'alice-2'")
    expect(await hellos()).toEqual([])
  })

  it('prints "already joined as @h" when a live session of this member holds the handle', async () => {
    expect((await join()).code).toBe(0)
    const token = (await w.local.readCredentials()).hubs[w.url]?.member_token ?? ''
    const live = await w.member('unused', token, 'live-session')
    await live.session.join({ room_id: w.roomId, handle: 'payments-api' })
    const again = await join({ here: true }, { ...CLAUDE, CLAUDE_CODE_SESSION_ID: 'cc-other' })
    expect(again.code).toBe(0)
    expect(again.out).toContain('[5/7] join: already joined as @payments-api')
    expect(again.out).toContain('nothing to do: @payments-api is already live in "Payments Team"')
    expect(again.out).not.toContain('[6/7]')
  })

  it('fails before redeeming when there is no binary to install', async () => {
    const result = await join({ here: true }, CLAUDE, { sourceBinary: undefined })
    expect(result.code).toBe(1)
    expect(result.out).toContain('no binary to install')
    expect(result.err).toContain('nothing was redeemed')
    expect(await w.local.readCredentials()).toEqual({ hubs: {} })
  })

  it('a failing selftest fails loudly before redeeming', async () => {
    w.m.env = { ...w.m.env, FAKE_SELFTEST_FAIL: '1' }
    const result = await join()
    expect(result.code).toBe(1)
    expect(result.out).toContain('selftest claude-code failed')
    expect(await w.local.readCredentials()).toEqual({ hubs: {} })
  })
})

describe('agent-peers join: remember scopes', () => {
  it('$HOME defaults to session scope', async () => {
    const result = await join({ here: true }, CLAUDE, { cwd: w.m.home })
    expect(result.code).toBe(0)
    expect(result.out).toContain('session scope')
    expect((await w.local.readAutojoin())[0]?.scope).toBe('session')
  })

  it('a directory outside any git repo defaults to session scope', async () => {
    const dir = joinPath(w.m.root, 'scratch')
    await mkdir(dir)
    await join({ here: true }, CLAUDE, { cwd: dir })
    expect((await w.local.readAutojoin())[0]).toMatchObject({ scope: 'session', handle: 'scratch' })
  })

  it('--remember none writes no entry; --remember workspace is honoured outside git', async () => {
    const none = await join({ here: true, remember: 'none' })
    expect(none.out).toContain('not remembered (--remember none)')
    expect(await w.local.readAutojoin()).toEqual([])
    await join({ here: true, remember: 'workspace' }, CLAUDE, { cwd: w.m.home })
    expect((await w.local.readAutojoin())[0]?.scope).toBe('workspace')
  })
})
