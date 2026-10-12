import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runAsk } from '../../src/commands/ask'
import { openInBrowser, runDashboard } from '../../src/commands/dashboard'
import { runInbox } from '../../src/commands/inbox'
import { runKnock } from '../../src/commands/knock'
import { runLeave } from '../../src/commands/leave'
import { runRename } from '../../src/commands/rename'
import { runSay } from '../../src/commands/say'
import { runStatus } from '../../src/commands/status'
import { runWho } from '../../src/commands/who'
import { runJoin } from '../../src/join/run'
import type { PeersDeps } from '../../src/join/types'
import { installFakeClaude } from '../helpers/fake-agents'
import { type JoinWorld, type Owner, output, roomTexts, startJoinWorld } from '../helpers/join-world'
import type { memoryIo } from '../helpers/world'

let w: JoinWorld
const AGENT = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }

beforeEach(async () => {
  w = await startJoinWorld()
  await installFakeClaude(w.m)
  const io = w.io(AGENT)
  const code = await runJoin(w.inviteUrl, { here: true }, io, w.deps())
  if (code !== 0) throw new Error(output(io).err)
})
afterEach(async () => {
  await w.stop()
})

type Io = ReturnType<typeof memoryIo>
async function shell(
  run: (io: Io, deps: PeersDeps) => Promise<number>,
  env: Record<string, string> = AGENT,
  extra: Partial<PeersDeps> = {},
) {
  const io = w.io(env)
  const code = await run(io, w.deps(extra))
  return { code, ...output(io) }
}

/** Answers every ask it receives (or does `onAsk` instead). */
function answering(owner: Owner, onAsk?: (askId: string) => Promise<void>) {
  return owner.session.on('msg.new', ({ message }) => {
    if (message.kind !== 'ask') return
    const work = onAsk
      ? onAsk(message.id)
      : owner.session
          .claim(message.id)
          .then(() => owner.session.reply({ ask_id: message.id, text: 'retries: 3x' }))
    work.catch(() => undefined)
  })
}

describe('who', () => {
  it('lists the room as the agent session', async () => {
    const result = await shell((io, deps) => runWho(undefined, {}, io, deps))
    expect(result.code).toBe(0)
    expect(result.out).toContain('#payments · you are @payments-api')
    expect(result.out).toContain('@alice · claude-code · model ? · online · unknown')
    expect(result.out).toContain('(you)')
  })

  it('as the CLI session it joins the remembered rooms', async () => {
    const result = await shell((io, deps) => runWho('payments', {}, io, deps), {})
    expect(result.code).toBe(0)
    expect(result.out).toContain('#payments · you are @payments-api')
    const cli = await shell((io, deps) => runWho(undefined, {}, io, deps), {})
    expect(cli.out).toContain('#payments')
  })

  it('an unknown room fails; no credentials fails with exit 5', async () => {
    expect((await shell((io, deps) => runWho('nope', {}, io, deps))).code).toBe(1)
    await w.local.removeCredential(w.url)
    const none = await shell((io, deps) => runWho(undefined, {}, io, deps))
    expect(none.code).toBe(5)
    expect(none.err).toContain('not a member of any hub')
  })
})

describe('ask', () => {
  it('waits for the reply and prints it inside the envelope', async () => {
    const off = answering(w.alice)
    const result = await shell((io, deps) => runAsk('@alice', ['retry', 'policy?'], { wait: 5 }, io, deps))
    off()
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/ask \w+ to @alice in #payments: (queued|delivered)/)
    expect(result.out).toContain('[agent-peers] REPLY from @alice to your ask')
    expect(result.out).toContain('retries: 3x')
  })

  it('without --wait it only sends; at the deadline it reports pending', async () => {
    const sent = await shell((io, deps) => runAsk('alice@payments', ['q'], { write: true }, io, deps))
    expect(sent.code).toBe(0)
    expect(sent.out).not.toContain('pending')
    const pending = await shell((io, deps) => runAsk('@alice', ['q2'], { wait: 0.2 }, io, deps))
    expect(pending.out).toContain('pending · @alice · claude-code')
  })

  it('reports an ask that fails without a reply', async () => {
    const code = w.inviteUrl.split('/').at(-1) ?? ''
    const carol = await w.member('carol')
    await carol.session.join({ invite_code: code, handle: 'carol' })
    const off = answering(carol, () => carol.session.leave(w.roomId))
    const result = await shell((io, deps) => runAsk('@carol', ['q'], { wait: 5 }, io, deps))
    off()
    expect(result.code).toBe(1)
    expect(result.out).toContain('ask failed (not_in_room)')
  })

  it('rejects bad targets and unknown handles', async () => {
    expect((await shell((io, deps) => runAsk('@Bad Target', ['q'], {}, io, deps))).code).toBe(2)
    expect((await shell((io, deps) => runAsk('@alice', [], {}, io, deps))).code).toBe(2)
    const unknown = await shell((io, deps) => runAsk('@nobody', ['q'], {}, io, deps))
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('nobody is @nobody in your rooms')
  })
})

describe('say and inbox', () => {
  it('say chats in the room', async () => {
    const result = await shell((io, deps) => runSay(['deploy', 'done'], {}, io, deps))
    expect(result.code).toBe(0)
    expect(result.out).toContain('said in #payments as @payments-api')
    expect(await roomTexts(w)).toContain('deploy done')
    expect((await shell((io, deps) => runSay([' '], {}, io, deps))).code).toBe(2)
  })

  it('inbox prints unread messages in envelopes, then marks them read', async () => {
    await w.alice.session.send({ room_id: w.roomId, text: 'news: v2 shipped' })
    const peek = await shell((io, deps) => runInbox({ peek: true }, io, deps))
    expect(peek.out).toContain('[agent-peers] CHAT from @alice')
    expect(peek.out).toContain('news: v2 shipped')
    const read = await shell((io, deps) => runInbox({}, io, deps))
    expect(read.out).toContain('news: v2 shipped')
    const empty = await shell((io, deps) => runInbox({ room: 'payments' }, io, deps))
    expect(empty.out).toContain('inbox empty')
  })
})

describe('rename, status, leave', () => {
  it('renames the title and the handle, and autojoin.json follows', async () => {
    const title = await shell((io, deps) => runRename(['调研', 'retries'], {}, io, deps))
    expect(title.out).toContain('title: 调研 retries')
    const handle = await shell((io, deps) => runRename([], { handle: '@api', room: 'payments' }, io, deps))
    expect(handle.code).toBe(0)
    expect(handle.out).toContain('@payments-api is now @api in #payments')
    expect((await w.local.readAutojoin())[0]?.handle).toBe('api')
    expect((await shell((io, deps) => runRename([], {}, io, deps))).code).toBe(2)
    expect((await shell((io, deps) => runRename([], { handle: 'x', room: 'nope' }, io, deps))).code).toBe(1)
  })

  it('status sets the summary and DND', async () => {
    const result = await shell((io, deps) => runStatus(['refactoring', 'retries'], { dnd: true }, io, deps))
    expect(result.out).toContain('summary: refactoring retries')
    expect(result.out).toContain('do not disturb')
    const { members } = await w.alice.session.peers(w.roomId)
    expect(members.find((m) => m.handle === 'payments-api')?.card).toMatchObject({
      summary: 'refactoring retries',
      accepting: false,
    })
    expect((await shell((io, deps) => runStatus([], { open: true }, io, deps))).out).toContain(
      'accepting asks',
    )
    expect((await shell((io, deps) => runStatus([], {}, io, deps))).code).toBe(2)
    expect((await shell((io, deps) => runStatus(['x'], { dnd: true, open: true }, io, deps))).code).toBe(2)
  })

  it('leave releases the handle and forgets the room', async () => {
    const result = await shell((io, deps) => runLeave(undefined, {}, io, deps))
    expect(result.code).toBe(0)
    expect(result.out).toContain('left #payments: @payments-api is released and no longer auto-joined')
    expect(await w.local.readAutojoin()).toEqual([])
    expect(await roomTexts(w)).toContain('@payments-api left')
  })
})

describe('knock and dashboard', () => {
  it('knocks on a discoverable room', async () => {
    await w.alice.client.request('room.create', {
      session_id: w.alice.session.sessionId,
      name: 'infra',
      discoverable: true,
    })
    const result = await shell((io, deps) => runKnock('#infra', ['let', 'me', 'in'], {}, io, deps))
    expect(result.code).toBe(0)
    expect(result.out).toContain('knocked on #infra')
    expect(result.out).toContain('the owner @alice decides')
    const member = await shell((io, deps) => runKnock('payments', [], {}, io, deps))
    expect(member.out).toContain('already a member of #payments')
    expect((await shell((io, deps) => runKnock('nope', [], {}, io, deps))).code).toBe(1)
  })

  it('dashboard opens a one-time login link', async () => {
    const opened: string[] = []
    const openUrl = async (url: string) => {
      opened.push(url)
      return true
    }
    const result = await shell((io, deps) => runDashboard({}, io, deps), AGENT, { openUrl })
    expect(result.code).toBe(0)
    expect(opened[0]).toContain('/app/login?c=')
    expect(result.out).toContain(`opened (single use, valid for 5 minutes): ${opened[0]}`)
    const manual = await shell((io, deps) => runDashboard({}, io, deps), AGENT, {
      openUrl: async () => false,
    })
    expect(manual.out).toContain('open this link')
    expect(await openInBrowser('https://x', 'aix')).toBe(false)
  })
})
