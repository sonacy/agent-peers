/**
 * `join` and shell-command test world: a real in-process hub (':memory:', port 0, HTTP mounted), an
 * owner @alice who created room "payments", a fake machine (temp HOME, fake agents on PATH, fake
 * agent-peers binary) and a git workspace. Nothing real is touched.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HubClient, LocalHome, type ProcessTree, SessionHandle } from '@agent-peers/core'
import { createHub, type Hub, silentLogger } from '@agent-peers/hub'
import type { PeersDeps } from '../../src/join/types'
import { type FakeMachine, fakeMachine } from './fake-agents'
import { memoryIo } from './world'

export interface Owner {
  readonly client: HubClient
  readonly session: SessionHandle
}

export interface JoinWorld {
  readonly m: FakeMachine
  readonly hub: Hub
  readonly url: string
  readonly roomId: string
  readonly inviteUrl: string
  readonly workspace: string
  readonly alice: Owner
  readonly local: LocalHome
  deps(extra?: Partial<PeersDeps>): PeersDeps
  io(env?: Record<string, string>): ReturnType<typeof memoryIo>
  /** Connects another member of this hub (a peer in the room when `roomId` is given). */
  member(name: string, token?: string, localKey?: string): Promise<Owner>
  stop(): Promise<void>
}

/** Nothing is alive except this test process: no bridge, no agent ancestors. */
export const quietTree: ProcessTree = {
  lookup: async () => undefined,
  isAlive: (pid) => pid === process.pid,
}

export async function connect(
  url: string,
  token: string,
  localKey: string,
  host = 'peer-host',
): Promise<Owner> {
  const client = new HubClient({
    bridge: { agent_kind: 'claude-code', adapter: '0.1.0', host },
    heartbeatMs: 60_000,
    reconnect: false,
  })
  await client.connect(url, token)
  const session = new SessionHandle(client, {
    localKey,
    card: { agent: { kind: 'claude-code', adapter: '0.1.0' }, host },
  })
  await session.open()
  return { client, session }
}

export async function gitWorkspace(root: string, name = 'payments-api'): Promise<string> {
  const dir = join(root, 'src', name)
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(
    join(dir, '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:acme/payments-api.git\n',
  )
  return dir
}

export async function startJoinWorld(): Promise<JoinWorld> {
  const m = await fakeMachine()
  const hub = createHub({ publicBind: '127.0.0.1', publicPort: 0, adminPort: 0, logger: silentLogger })
  const info = await hub.start()
  const url = `http://127.0.0.1:${info.publicPort}`
  const owners: Owner[] = []
  const alice = await connect(url, hub.services.members.create('alice').token, 'alice-conv', 'alice-laptop')
  owners.push(alice)
  const created = await alice.client.request('room.create', {
    session_id: alice.session.sessionId,
    name: 'payments',
    display_name: 'Payments Team',
    handle: 'alice',
  })
  const workspace = await gitWorkspace(m.root)
  const world: JoinWorld = {
    m,
    hub,
    url,
    roomId: created.room.room_id,
    inviteUrl: created.invite_url,
    workspace,
    alice,
    local: new LocalHome({ root: m.peersHome, userHome: m.home }),
    deps: (extra = {}) => ({
      ...m.deps(),
      cwd: workspace,
      hostname: 'bob-mbp.local',
      newId: () => '01JBOOTSTRAP0000000000000',
      processTree: quietTree,
      requestTimeoutMs: 5_000,
      ...extra,
    }),
    io: (env = {}) => memoryIo({ ...m.env, ...env }),
    async member(name, token, localKey) {
      const owner = await connect(
        url,
        token ?? hub.services.members.create(name).token,
        localKey ?? `${name}-conv`,
      )
      owners.push(owner)
      return owner
    },
    async stop() {
      for (const owner of owners) {
        owner.session.dispose()
        await owner.client.close()
      }
      await hub.stop()
      await m.cleanup()
    },
  }
  return world
}

/** Messages in the room as the owner sees them. */
export async function roomTexts(world: JoinWorld): Promise<readonly string[]> {
  const { messages } = await world.alice.session.history(world.roomId, { limit: 200 })
  return messages.map((message) => message.text)
}

export const output = (io: ReturnType<typeof memoryIo>) => ({ out: io.out.join(''), err: io.err.join('') })
