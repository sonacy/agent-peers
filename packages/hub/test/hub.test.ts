import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardInputSchema } from '@agent-peers/protocol'
import { ADMIN_TOKEN_FILE, INVITE_SECRET_FILE, writeSecret } from '../src/bootstrap'
import { type Logger, silentLogger } from '../src/config'
import { createHub, type Hub } from '../src/hub'
import { DB_FILE } from '../src/storage/db'
import { FakeClock } from './helpers/fake-clock'

const dirs: string[] = []
const hubs: Hub[] = []

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop().catch(() => undefined)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-peers-hub-'))
  dirs.push(dir)
  return dir
}

function make(options: Parameters<typeof createHub>[0] = {}): Hub {
  const hub = createHub({
    publicBind: '127.0.0.1',
    publicPort: 0,
    adminPort: 0,
    logger: silentLogger,
    clock: new FakeClock(),
    ...options,
  })
  hubs.push(hub)
  return hub
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return { warnings, info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined }
}

describe('createHub', () => {
  it('starts both listeners, bootstraps the default room and serves mounts', async () => {
    const hub = make({
      mounts: (ctx) => ({
        public: (req) =>
          new URL(req.url).pathname === '/hello' ? new Response(ctx.config.version) : undefined,
        admin: async () => new Response('admin'),
      }),
    })
    const info = await hub.start()
    expect(info.publicPort).toBeGreaterThan(0)
    expect(info.adminPort).toBeGreaterThan(0)
    expect(info.adminToken.startsWith('apa_')).toBe(true)
    expect(info.publicUrl).toBe(`http://127.0.0.1:${info.publicPort}`)
    expect(info.bootstrapInviteUrl).toMatch(/\/j\/[0-9A-Z]{16}$/)
    expect(hub.services.auth.verifyAdmin(info.adminToken)).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${info.publicPort}/hello`)).text()).toBe('0.1.0')
    expect((await fetch(`http://127.0.0.1:${info.publicPort}/other`)).status).toBe(404)
    expect(await (await fetch(`http://127.0.0.1:${info.adminPort}/x`)).text()).toBe('admin')
    hub.setMounts({})
    expect((await fetch(`http://127.0.0.1:${info.adminPort}/x`)).status).toBe(404)
    await expect(hub.start()).rejects.toThrow('already started')
  })

  it('persists the admin token (0600) and invite secret across restarts', async () => {
    const dataDir = await tempDir()
    const first = make({ dataDir })
    const info = await first.start()
    const prompt = first.services.invites.promptFor(
      first.services.deps.repos.rooms.activeByName('default')?.id ?? '',
    )
    await first.stop()
    hubs.splice(hubs.indexOf(first), 1)
    const tokenPath = join(dataDir, ADMIN_TOKEN_FILE)
    expect((await readFile(tokenPath, 'utf8')).trim()).toBe(info.adminToken)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dataDir, INVITE_SECRET_FILE))).mode & 0o777).toBe(0o600)
    const second = make({ dataDir, publicPort: info.publicPort })
    const again = await second.start()
    expect(again.adminToken).toBe(info.adminToken)
    expect(again.bootstrapInviteUrl).toBeUndefined()
    const room = second.services.deps.repos.rooms.activeByName('default')
    expect(second.services.invites.promptFor(room?.id ?? '')).toBe(prompt)
  })

  it('mints a new admin token when the file no longer matches', async () => {
    const dataDir = await tempDir()
    const first = make({ dataDir })
    const info = await first.start()
    await first.stop()
    hubs.splice(hubs.indexOf(first), 1)
    await writeSecret(join(dataDir, ADMIN_TOKEN_FILE), 'apa_tampered')
    const second = make({ dataDir })
    const again = await second.start()
    expect(again.adminToken).not.toBe(info.adminToken)
    expect(second.services.auth.verifyAdmin(again.adminToken)).toBe(true)
  })

  it('skips the default room on open registration and warns without a public URL', async () => {
    const open = make({ registration: 'open' })
    expect((await open.start()).bootstrapInviteUrl).toBeUndefined()
    expect(open.services.deps.repos.rooms.listActive()).toHaveLength(0)
    const logger = recordingLogger()
    const lan = make({ publicBind: '0.0.0.0', adminBind: '0.0.0.0', logger })
    const info = await lan.start()
    expect(info.publicUrl).toBeUndefined()
    expect(info.bootstrapInviteUrl).toBeUndefined()
    expect(logger.warnings.some((w) => w.includes('non-loopback'))).toBe(true)
    expect(logger.warnings.some((w) => w.includes('--public-url'))).toBe(true)
  })

  it('uses a configured invite secret and the configured public URL', async () => {
    const hub = make({ inviteSecret: 'fixed', publicUrl: 'https://hub.example.com/' })
    const info = await hub.start()
    expect(info.bootstrapInviteUrl?.startsWith('https://hub.example.com/j/')).toBe(true)
    expect(hub.runtime.inviteSecret).toBe('fixed')
  })

  it('stops cleanly with connected clients and sweeps on its interval', async () => {
    const clock = new FakeClock()
    const hub = make({ clock, sweepIntervalMs: 1000 })
    const info = await hub.start()
    const token = hub.services.members.create('alice').token
    const Ctor = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket
    const ws = new Ctor(`ws://127.0.0.1:${info.publicPort}/v0/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    await new Promise((resolve) => ws.addEventListener('open', resolve))
    clock.advance(3500)
    expect(clock.pending).toBeGreaterThan(0)
    await hub.stop()
    hubs.splice(hubs.indexOf(hub), 1)
    expect(clock.pending).toBe(0)
    await hub.stop()
    await expect(hub.start()).rejects.toThrow('stopped')
  })

  it('releases the public port when the admin port is taken, and can start again', async () => {
    const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('busy') })
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
    const publicPort = probe.port ?? 0
    await probe.stop(true)
    const hub = make({ publicPort, adminPort: blocker.port ?? 0 })
    await expect(hub.start()).rejects.toThrow()
    const rebind = Bun.serve({ hostname: '127.0.0.1', port: publicPort, fetch: () => new Response('free') })
    await rebind.stop(true)
    await blocker.stop(true)
    const info = await hub.start()
    expect(info.publicPort).toBe(publicPort)
  })

  it('creates the database files 0600 and tightens an existing 0755 data dir', async () => {
    const dataDir = await tempDir()
    await chmod(dataDir, 0o755)
    const hub = make({ dataDir })
    await hub.start()
    hub.services.members.create('alice')
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700)
    for (const suffix of ['', '-wal', '-shm']) {
      expect((await stat(join(dataDir, `${DB_FILE}${suffix}`))).mode & 0o777).toBe(0o600)
    }
  })

  it('after a restart, sessions that were attached get grace, then their asks are handled (§6.2)', async () => {
    const dataDir = await tempDir()
    const clock = new FakeClock()
    const first = make({ dataDir, clock, graceMs: 1000 })
    await first.start()
    const s = first.services
    const card = CardInputSchema.parse({ agent: { kind: 'claude-code', adapter: '0.3.0' }, host: 'h' })
    const alice = s.members.create('alice').member.id
    const bob = s.members.create('bob').member.id
    const room = s.rooms.create({ kind: 'member', memberId: alice }, { name: 'team' }).room_id
    s.deps.repos.grants.upsert(room, bob, 'member', clock.now())
    const a = s.sessions.open({ memberId: alice, outdated: false }, { local_key: 'a', card }).session_id
    const b = s.sessions.open({ memberId: bob, outdated: false }, { local_key: 'b', card }).session_id
    s.rooms.join(a, { session_id: a, room_id: room, handle: 'home' } as never)
    s.rooms.join(b, { session_id: b, room_id: room, handle: 'work' } as never)
    const ask = (id: string) =>
      s.sending.send(a, {
        session_id: a,
        client_msg_id: id,
        room_id: room,
        kind: 'ask',
        to: ['work'],
        text: id,
      })
    const working = ask('w').id
    const delivered = ask('d').id
    s.asks.claim(b, working)
    await first.stop()
    hubs.splice(hubs.indexOf(first), 1)

    const second = make({ dataDir, clock, graceMs: 1000 })
    await second.start()
    const row = (id: string) => second.services.deps.repos.asks.byId(id)
    expect(second.services.deps.repos.sessions.byId(b)?.connection).toBe('stale')
    expect(row(working)?.state).toBe('working')
    clock.advance(1000)
    expect(second.services.deps.repos.sessions.byId(b)?.connection).toBe('offline')
    expect(row(working)).toMatchObject({ state: 'failed', reason: 'target_lost' })
    expect(row(delivered)?.state).toBe('queued')
  })
})
