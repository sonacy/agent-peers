import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Activity } from '@agent-peers/protocol'
import type { InjectTarget } from '../../src/inject/injector'
import { CodexQueueInjector, type CodexQueueOptions } from '../../src/injectors/codex/queue-injector'
import { injectorFor } from '../../src/injectors/index'
import type { BridgeSurface } from '../../src/surface/surfaces'
import { eventually, startWorld, type World } from '../helpers/world'
import { readArgvLog, writeFakeCodex } from './fake-codex'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apb-cq-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const target = (
  activity: Activity = 'idle',
  hooked = true,
  surface: BridgeSurface = 'codex',
): InjectTarget & { injectId: string } => ({ localKey: 't-1', surface, activity, hooked, injectId: 'inj_1' })

async function injector(env: Record<string, string> = {}, extra: Partial<CodexQueueOptions> = {}) {
  const fake = await writeFakeCodex(join(dir, 'bin'))
  const logs: string[] = []
  const queue = new CodexQueueInjector({
    env: { CODEX_CLI_PATH: fake.path, FAKE_CODEX_LOG: fake.log, CODEX_HOME: join(dir, 'none'), ...env },
    surface: 'codex',
    log: (line) => logs.push(line),
    ...extra,
  })
  await queue.probe('cli')
  return { queue, fake, logs }
}

describe('CodexQueueInjector', () => {
  it('queues an envelope for an idle, hooked thread and records the channel', async () => {
    const { queue, fake } = await injector()
    expect(queue.probeState()).toMatchObject({ status: 'ok', version: '0.160.1' })
    // `push` is advertised only once a queue call proved the thread is daemon-hosted.
    expect(queue.tier(target())).toBeUndefined()
    expect(queue.canPush(target())).toBe(true)
    expect(await queue.push('[agent-peers] ASK from @home\nline two', target())).toBe('delivered')
    expect(queue.tier(target())).toBe('push')
    expect(await readArgvLog(fake.log)).toEqual([
      ['queue', '--thread', 't-1', '--message', '[agent-peers] ASK from @home\nline two'],
    ])
    expect(queue.deliveries).toHaveLength(1)
    expect(queue.deliveries[0]).toMatchObject({ injectId: 'inj_1', thread: 't-1', channel: 'codex-queue' })
  })

  it('never queues for a busy, interrupted (still busy), unknown or unhooked thread', async () => {
    const { queue, fake } = await injector()
    for (const t of [target('busy'), target('unknown'), target('awaiting_input'), target('idle', false)]) {
      expect(queue.canPush(t)).toBe(false)
      expect(await queue.push('E', t)).toBe('unsupported')
    }
    expect(queue.tier(target('idle', false))).toBeUndefined()
    expect(await readArgvLog(fake.log)).toEqual([])
  })

  it('backs off a thread after a failed queue and serves it through hooks meanwhile', async () => {
    let now = 1_000
    const { queue, logs } = await injector(
      { FAKE_CODEX_EXIT: '3' },
      { now: () => now, failureBackoffMs: 500 },
    )
    expect(await queue.push('E', target())).toBe('unsupported')
    expect(logs.join('\n')).toContain('exit 3: fake codex failure')
    expect(queue.canPush(target())).toBe(false)
    expect(queue.tier(target())).toBeUndefined()
    now += 600
    expect(queue.canPush(target())).toBe(true)
    // Never confirmed daemon-hosted: still not advertised as push.
    expect(queue.tier(target())).toBeUndefined()
  })

  it('treats a timed-out queue call as queued (never pushed twice) and backs off', async () => {
    const { queue, logs } = await injector({ FAKE_CODEX_SLEEP_MS: '2000' }, { timeoutMs: 100 })
    expect(await queue.push('E', target())).toBe('delivered')
    expect(logs.join('\n')).toContain('timed out')
    expect(queue.canPush(target())).toBe(false)
  })

  it('is unavailable without a shared daemon, with an old CLI or without any CLI', async () => {
    const remote = await injector({ CODEX_EXEC_SERVER_URL: 'ws://example' })
    expect(remote.queue.probeState()).toMatchObject({ status: 'unavailable' })
    expect(remote.queue.canPush(target())).toBe(false)
    const old = await injector({ FAKE_CODEX_VERSION: '0.150.0' })
    expect(old.queue.probeState()).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('older'),
    })
    expect(old.logs.join('\n')).toContain('codex queue unavailable')
    const none = await injector({}, { resolve: async () => undefined })
    expect(none.queue.probeState()).toEqual({ status: 'unavailable', reason: 'codex CLI not found' })
    const broken = await injector(
      {},
      {
        resolve: async () => {
          throw new Error('disk on fire')
        },
      },
    )
    expect(broken.queue.probeState()).toMatchObject({ reason: expect.stringContaining('disk on fire') })
    expect(await broken.queue.probe('cli')).toMatchObject({ status: 'unavailable' })
  })

  it('probes the desktop preference lazily when a thread turns out to be Codex desktop', async () => {
    const { queue } = await injector()
    const desktop = target('idle', true, 'codex-desktop')
    expect(queue.probeState('codex-desktop')).toEqual({ status: 'pending' })
    expect(queue.canPush(desktop)).toBe(false)
    await eventually(() => (queue.probeState('codex-desktop').status === 'ok' ? true : undefined))
    expect(queue.canPush(desktop)).toBe(true)
  })
})

describe('injectorFor', () => {
  it('picks the injector per surface', async () => {
    const env = { CODEX_CLI_PATH: join(dir, 'missing') }
    expect(injectorFor('claude-code', { env }).kind).toBe('claude-code-rewake')
    const cc = (hooked: boolean, waiting: boolean) =>
      injectorFor('claude-code', { env }).tier?.({ ...target('idle', hooked, 'claude-code'), waiting })
    expect(cc(true, true)).toBe('push')
    expect(cc(true, false)).toBe('boundary')
    expect(cc(false, true)).toBe('poll')
    const claude = injectorFor('claude-code', { env })
    expect(claude.canPush(target('idle', true, 'claude-code'))).toBe(false)
    expect(await claude.push('E', target('idle', true, 'claude-code'))).toBe('unsupported')
    const desktop = injectorFor('claude-desktop', { env })
    expect(desktop.kind).toBe('poll')
    expect(desktop.canPush(target('idle', true, 'claude-desktop'))).toBe(false)
    const resolve = async () => undefined
    expect(injectorFor('codex', { env, resolve }).kind).toBe('codex-queue')
    expect(injectorFor('codex-desktop', { env, resolve }).kind).toBe('codex-queue')
  })
})

describe('codex bridge with the queue injector', () => {
  let world: World
  beforeEach(async () => {
    world = await startWorld()
  })
  afterEach(async () => {
    await world.stop()
  })

  it('pushes asks into an idle thread exactly once and advertises push', async () => {
    const fake = await writeFakeCodex(join(world.dir, 'bin'))
    const queue = new CodexQueueInjector({
      env: { CODEX_CLI_PATH: fake.path, FAKE_CODEX_LOG: fake.log },
      surface: 'codex',
    })
    await queue.probe('cli')
    const alice = await world.peer('alice')
    const room = await world.room(alice, 'team', 'home')
    const cwd = join(world.dir, 'repo')
    await mkdir(cwd, { recursive: true })
    const codex = await world.bridge('codex', { token: world.member('dave'), injector: queue })
    const meta = { 'x-codex-turn-metadata': { thread_id: 't-1', turn_id: 'turn-1' } }
    expect(
      (await codex.call('peers_join', { invite: room.code, handle: 'work', remember: 'none' }, meta)).isError,
    ).toBe(false)
    const hook = async (event: string, fields: Record<string, unknown> = {}) => {
      const out = await codex.call('peers_hook', {
        hook_event_name: event,
        session_id: 't-1',
        cwd,
        ...fields,
      })
      return JSON.parse(out.text) as Record<string, unknown>
    }
    await hook('SessionStart', { source: 'startup' })
    const session = () => codex.bridge.runtime?.registry.get('t-1')
    expect(session()?.tier).toBe('boundary')
    await hook('UserPromptSubmit', { turn_id: 'turn-1' })
    expect(await hook('Stop', { last_assistant_message: 'done', turn_id: 'turn-1' })).toEqual({})
    expect(session()?.activity).toBe('idle')
    const asked = await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'which port?' })
    const argv = await eventually(async () => {
      const calls = await readArgvLog(fake.log)
      return calls.length > 0 ? calls : undefined
    })
    expect(argv).toHaveLength(1)
    expect(argv[0]?.slice(0, 4)).toEqual(['queue', '--thread', 't-1', '--message'])
    expect(argv[0]?.[4]).toContain(`ask_id ${asked.id}`)
    expect(queue.deliveries[0]?.thread).toBe('t-1')
    expect(session()?.tier).toBe('push')
    // Queued, not yet running: the ask is not in a peer turn and is not leased (Codex owns it).
    expect(session()?.queue.peerTurn).toBeNull()
    expect(session()?.queue.nextLeaseExpiry()).toBeUndefined()
    // A second ask while the first push is in flight is not queued as a second Codex turn.
    const second = await alice.session.ask({ room_id: room.roomId, to: 'work', text: 'and the host?' })
    await eventually(() => (session()?.queue.state.items.some((i) => i.id === second.id) ? true : undefined))
    await session()?.settled()
    expect(await readArgvLog(fake.log)).toHaveLength(1)
    // The queued turn starts: its ask joins the peer turn; the prompt hook hands out the held one.
    const prompt = await hook('UserPromptSubmit', { turn_id: 'turn-2' })
    expect(session()?.queue.peerTurn?.ask_ids).toEqual([asked.id, second.id])
    expect(JSON.stringify(prompt)).toContain(`ask_id ${second.id}`)
    expect(JSON.stringify(prompt)).not.toContain(`ask_id ${asked.id}`)
    expect(await readArgvLog(fake.log)).toHaveLength(1)
  })
})
