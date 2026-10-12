import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HubClient,
  type HubClientOptions,
  LocalHome,
  type MethodName,
  type ParamsOf,
  type RequestOptions,
  type ResultOf,
  SessionHandle,
} from '@agent-peers/core'
import { ADMIN } from '@agent-peers/hub'
import { eventually, type Peer, startWorld, testClientFactory, type World } from './helpers/world'

let world: World
let pids = 4600

beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.stop()
})

interface Fixture {
  readonly alice: Peer
  readonly roomId: string
  readonly code: string
  readonly token: string
  readonly homeDir: string
  readonly workspace: string
}

async function fixture(): Promise<Fixture> {
  const alice = await world.peer('alice')
  const room = await world.room(alice, 'team', 'home')
  const workspace = join(world.dir, 'api')
  await mkdir(workspace, { recursive: true })
  return {
    alice,
    roomId: room.roomId,
    code: room.code,
    token: world.member('carol'),
    homeDir: join(world.dir, 'carol-home'),
    workspace: await realpath(workspace),
  }
}

/** Records `session.open` params, so a test can see `supersedes`. */
class RecordingClient extends HubClient {
  static opened: unknown[] = []
  override request<M extends MethodName>(method: M, params: ParamsOf<M>, options?: RequestOptions) {
    if (method === 'session.open') RecordingClient.opened = [...RecordingClient.opened, params]
    return super.request(method, params, options) as Promise<ResultOf<M>>
  }
}

const recordingFactory = (options: HubClientOptions): HubClient =>
  new RecordingClient({ ...options, heartbeatMs: 60_000, reconnect: false })

function claude(f: Fixture, key: string, recording = false) {
  pids += 1
  return world.bridge('claude-code', {
    ...(recording ? { hubClientFactory: recordingFactory } : {}),
    token: f.token,
    homeDir: f.homeDir,
    cwd: f.workspace,
    env: { CLAUDE_CODE_SESSION_ID: key },
    controlSocket: { runDir: join(world.dir, `r${pids}`), pid: pids, ancestorPids: [pids] },
  })
}

describe('autojoin on session open', () => {
  it('remembers a workspace join and re-claims the handle in the next session', async () => {
    const f = await fixture()
    const first = await claude(f, 'cc-1')
    const joined = await first.call('peers_join', { invite: f.code, handle: 'work', remember: 'workspace' })
    expect(joined.text).toContain(`future sessions in ${f.workspace} will auto-join @work`)
    await first.close()
    const second = await claude(f, 'cc-2')
    const session = second.bridge.runtime?.registry.get('cc-2')
    expect(session?.rooms.map((r) => r.handle)).toEqual(['work'])
    const entries = await second.home.readAutojoin()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.workspace).toBe(f.workspace)
  })

  it('never suffixes: a handle held by another live session is skipped', async () => {
    const f = await fixture()
    const first = await claude(f, 'cc-1')
    await first.call('peers_join', { invite: f.code, handle: 'work', remember: 'workspace' })
    const second = await claude(f, 'cc-2')
    expect(second.bridge.runtime?.registry.get('cc-2')?.rooms).toEqual([])
    expect(second.logs.join('\n')).toContain('@work is taken')
    expect(await second.home.readAutojoin()).toHaveLength(1)
  })

  it('treats the reattach result as authoritative: a room lost while offline is forgotten', async () => {
    const f = await fixture()
    const first = await claude(f, 'cc-1')
    await first.call('peers_join', { invite: f.code, handle: 'work', remember: 'workspace' })
    const sessionId = first.bridge.runtime?.registry.get('cc-1')?.sessionId as string
    await first.close()
    await f.alice.client.request('room.remove_session', {
      session_id: f.alice.session.sessionId,
      room_id: f.roomId,
      target_session_id: sessionId,
    })
    const again = await claude(f, 'cc-1')
    expect(again.bridge.runtime?.registry.get('cc-1')?.rooms).toEqual([])
    expect(await again.home.readAutojoin()).toEqual([])
    expect(again.logs.join('\n')).toContain('left while offline')
  })

  it('forgets a room the owner kicks it from, and follows admin renames', async () => {
    const f = await fixture()
    const cc = await claude(f, 'cc-1')
    await cc.call('peers_join', { invite: f.code, handle: 'work', remember: 'workspace' })
    world.hub.services.rename.renameHandle(ADMIN, f.roomId, 'work', 'desk')
    await eventually(async () => ((await cc.home.readAutojoin())[0]?.handle === 'desk' ? true : undefined))
    await f.alice.client.request('room.kick', {
      session_id: f.alice.session.sessionId,
      room_id: f.roomId,
      member: 'carol',
    })
    await eventually(async () => ((await cc.home.readAutojoin()).length === 0 ? true : undefined))
  })

  it('supersedes the bootstrap session that `agent-peers join` left behind', async () => {
    const f = await fixture()
    const client = testClientFactory({
      bridge: { agent_kind: 'claude-code', adapter: '0.1.0', host: 'testhost' },
    })
    const bootstrap = new SessionHandle(client, {
      localKey: 'bootstrap-01abc',
      card: { agent: { kind: 'claude-code', adapter: '0.1.0' }, host: 'testhost' },
    })
    await client.connect(world.url, f.token)
    await bootstrap.open()
    await bootstrap.join({ invite_code: f.code, handle: 'api' })
    await bootstrap.close()
    await client.close()
    const home = new LocalHome({ root: f.homeDir, userHome: world.dir })
    await home.rememberAutojoin({
      hub: world.url,
      room_id: f.roomId,
      handle: 'api',
      agent: 'claude-code',
      workspace: f.workspace,
      local_key: 'bootstrap-01abc',
      scope: 'workspace',
    })
    const cc = await claude(f, 'cc-real', true)
    expect(cc.bridge.runtime?.registry.get('cc-real')?.rooms.map((r) => r.handle)).toEqual(['api'])
    expect(RecordingClient.opened).toContainEqual(expect.objectContaining({ supersedes: 'bootstrap-01abc' }))
    // The entry now names the session that took over; the bootstrap key is never superseded again.
    expect((await home.readAutojoin()).map((e) => e.local_key)).toEqual(['cc-real'])
    await cc.close()
    RecordingClient.opened = []
    const next = await claude(f, 'cc-next', true)
    expect(next.bridge.runtime?.registry.get('cc-next')?.rooms.map((r) => r.handle)).toEqual(['api'])
    expect(RecordingClient.opened).not.toContainEqual(
      expect.objectContaining({ supersedes: 'bootstrap-01abc' }),
    )
    expect(next.logs.join('\n')).not.toContain('left while offline')
    expect(await home.readAutojoin()).toHaveLength(1)
  })

  it('drops entries for rooms that no longer exist', async () => {
    const f = await fixture()
    const home = new LocalHome({ root: f.homeDir, userHome: world.dir })
    await home.rememberAutojoin({
      hub: world.url,
      room_id: '01JNOSUCHROOM0000000000000',
      handle: 'work',
      agent: 'claude-code',
      workspace: f.workspace,
      scope: 'workspace',
    })
    const cc = await claude(f, 'cc-1')
    expect(cc.bridge.runtime?.registry.get('cc-1')?.rooms).toEqual([])
    expect(await home.readAutojoin()).toEqual([])
  })
})
