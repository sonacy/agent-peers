/**
 * The fixture server's hub pool: every test gets its own seeded demo hub (own ports, own data dir),
 * so flows never see each other's changes. A hub can be stopped and started again on the same
 * ports and database (the Core-disconnected flow).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DemoHub, startDemoHub } from '../../../packages/dashboard/scripts/demo/hub'
import { createHub, type Hub, type StaticSource, silentLogger } from '../../../packages/hub/src/index'
import type { HubInfo, WorldSize } from './contract'

const SMALL_WORLD = { bigRoomMembers: 12, bigRoomOnline: 4, bigRoomBusy: 2, bigRoomKnocks: 5 } as const

interface Entry {
  readonly info: HubInfo
  readonly demo: DemoHub
  readonly dataDir: string
  /** The hub serving now: the seeded one, or its replacement after a restart; undefined while stopped. */
  readonly live: Hub | undefined
}

export class HubPool {
  private readonly entries = new Map<string, Entry>()
  private next = 1

  constructor(private readonly source: StaticSource) {}

  async create(size: WorldSize): Promise<HubInfo> {
    const dataDir = await mkdtemp(join(tmpdir(), 'peers-e2e-hub-'))
    const demo = await startDemoHub({
      dataDir,
      source: this.source,
      logger: silentLogger,
      ...(size === 'small' ? SMALL_WORLD : {}),
    })
    const id = `h${this.next++}`
    const sessions = Object.fromEntries(
      Object.entries(demo.seeded.cast).map(([key, agent]) => [key, agent.sessionId] as const),
    )
    const info: HubInfo = {
      id,
      url: demo.url,
      adminUrl: demo.adminUrl,
      adminToken: demo.info.adminToken,
      rooms: demo.seeded.rooms,
      sessions,
    }
    this.entries.set(id, { info, demo, dataDir, live: demo.hub })
    return info
  }

  /** A one-time sign-in link for `member` (any demo member with a connected agent), minted through it. */
  async login(id: string, member: string): Promise<string> {
    const agent = this.entry(id).demo.seeded.agents.find(
      (a) => a.member === member && a.client.state === 'connected',
    )
    if (agent === undefined) throw new Error(`no connected agent for member ${member}`)
    return (await agent.handle.dashboardLogin()).url
  }

  /** The agent renames itself (as `/peers:rename` would): the dashboard must pick it up live. */
  async setTitle(id: string, key: string, title: string): Promise<void> {
    const agent = this.entry(id).demo.seeded.cast[key as keyof DemoHub['seeded']['cast']]
    if (agent === undefined) throw new Error(`no demo agent ${key}`)
    await agent.handle.rename({ title })
  }

  async stop(id: string): Promise<void> {
    const entry = this.entry(id)
    await entry.live?.stop()
    this.entries.set(id, { ...entry, live: undefined })
  }

  /** A fresh hub on the same ports and database (the seeded agents stay disconnected). */
  async restart(id: string): Promise<void> {
    const entry = this.entry(id)
    if (entry.live !== undefined) throw new Error(`hub ${id} is running`)
    const hub = createHub({
      publicBind: '127.0.0.1',
      publicPort: Number(new URL(entry.info.url).port),
      adminPort: Number(new URL(entry.info.adminUrl).port),
      dataDir: entry.dataDir,
      bootstrapDefaultRoom: false,
      idleCloseMs: 0,
      minAdapter: '0.1.0',
      logger: silentLogger,
      http: { dashboard: this.source, admin: this.source },
    })
    await hub.start()
    this.entries.set(id, { ...entry, live: hub })
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.entries.delete(id)
    await entry.demo.stop()
    await entry.live?.stop()
    await rm(entry.dataDir, { recursive: true, force: true })
  }

  async removeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.remove(id)))
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`unknown hub ${id}`)
    return entry
  }
}
