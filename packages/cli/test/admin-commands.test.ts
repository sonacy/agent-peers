import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adminBaseUrl, createAdminClient } from '../src/commands/admin-client'
import { findRoom } from '../src/commands/admin-rooms'
import { readAdminToken, writeHubState } from '../src/commands/hub-state'
import { inviteAction, inviteLines } from '../src/commands/invite'
import { roomTable } from '../src/commands/rooms'
import { type HubCli, runCli, startHubCli } from './helpers/hub-cli'

let hub: HubCli

beforeAll(async () => {
  hub = await startHubCli()
})

afterAll(async () => {
  await hub.cleanup()
})

const run = (...argv: string[]) => runCli(argv, hub.env)

describe('agent-peers invite', () => {
  it("prints the default room's join prompt", async () => {
    const result = await run('invite')
    expect(result.code).toBe(0)
    expect(result.out).toContain(`room "default": http://127.0.0.1:${hub.running.started.publicPort}/j/`)
    expect(result.out).toContain('Join my agent-peers room "default"')
  })

  it('creates a room with --create, renders zh prompts and prints JSON', async () => {
    const missing = await run('invite', 'team')
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('no room "team" on this hub (rooms: default); pass --create')
    const created = await run('--json', 'invite', 'team', '--create', '--lang', 'zh')
    expect(created.code).toBe(0)
    const body = JSON.parse(created.out)
    expect(body).toMatchObject({ room: 'team', action: 'show' })
    expect(body.join_prompt).toContain('加入我的 agent-peers 房间 "team"')
    expect(body.join_command).toContain(body.invite_url)
  })

  it('rotates with --new: the old code stops working', async () => {
    const before = JSON.parse((await run('invite', 'team', '--json')).out)
    const rotated = await run('invite', 'team', '--new')
    expect(rotated.code).toBe(0)
    expect(rotated.out).toContain('new invite minted: the previous code no longer works.')
    const after = JSON.parse((await run('invite', 'team', '--json')).out)
    expect(after.invite_url).not.toBe(before.invite_url)
    const code = String(before.invite_url).split('/').at(-1)
    const preview = await fetch(`http://127.0.0.1:${hub.running.started.publicPort}/v0/invites/${code}`)
    expect(preview.status).toBeGreaterThanOrEqual(400)
  })

  it('closes and reopens the invite', async () => {
    const closed = await run('invite', 'team', '--close')
    expect(closed.out).toContain('closed the invite to "team"')
    const again = await run('invite', 'team', '--close')
    expect(again.out).toContain('invites to "team" were already closed.')
    const listing = await run('rooms')
    expect(listing.out).toMatch(/team\s+0\s+0\s+0\s+0\s+closed/)
    const reopened = await run('invite', 'team', '--reopen')
    expect(reopened.code).toBe(0)
    expect(reopened.out).toContain('the invite is open.')
    const json = JSON.parse((await run('rooms', '--json')).out)
    expect(json.rooms.find((r: { name: string }) => r.name === 'team').invite).toMatch(/^inv_/)
  })

  it('refuses conflicting flags', async () => {
    const result = await run('invite', '--new', '--close')
    expect(result.code).toBe(2)
    expect(result.err).toContain('use only one of --new, --close and --reopen [invalid_params]')
    const json = await run('invite', '--new', '--reopen', '--json')
    expect(JSON.parse(json.out)).toEqual({
      error: { code: 'invalid_params', message: 'use only one of --new, --close and --reopen' },
    })
  })
})

describe('admin target resolution', () => {
  it('fails with exit 5 when there is no admin token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apa-'))
    const result = await runCli(['--home', join(dir, 'peers'), 'rooms'], { HOME: dir })
    expect(result.code).toBe(5)
    expect(result.err).toContain(`no admin token at ${join(dir, 'peers', 'hub', 'admin-token')}`)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails with exit 4 when the admin listener is down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apa-'))
    const dataDir = join(dir, 'data')
    await writeHubState(dataDir, {
      pid: 1,
      version: '0.1.0',
      public_port: 1,
      admin_port: 1,
      admin_bind: '127.0.0.1',
      public_url: null,
      started_at: 0,
    })
    await writeFile(join(dataDir, 'admin-token'), 'adm_x\n')
    const result = await runCli(['rooms', '--data-dir', dataDir], { HOME: dir })
    expect(result.code).toBe(4)
    expect(result.err).toContain("the hub's admin listener at http://127.0.0.1:1 is not reachable")
    await rm(dir, { recursive: true, force: true })
  })

  it('maps a wrong token to unauthorized and honors --admin-url', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apa-'))
    await writeFile(join(dir, 'admin-token'), 'adm_wrong\n')
    const url = `http://127.0.0.1:${hub.running.started.adminPort}`
    const result = await runCli(['rooms', '--data-dir', dir, '--admin-url', url], { HOME: dir })
    expect(result.code).toBe(5)
    expect(result.err).toContain('[unauthorized]')
    const bad = await runCli(['rooms', '--data-dir', dir, '--admin-url', 'nope'], { HOME: dir })
    expect(bad.code).toBe(2)
    expect(await adminBaseUrl(dir, 'https://x.test:9/a?b')).toBe('https://x.test:9')
    await expect(adminBaseUrl(dir, 'ftp://x')).rejects.toThrow('http(s)')
    expect(await adminBaseUrl(dir)).toBe('http://127.0.0.1:7338')
    await rm(dir, { recursive: true, force: true })
  })

  it('reports non-JSON error bodies and malformed responses', async () => {
    const target = { baseUrl: 'http://admin.test', token: 't' }
    const html = createAdminClient(target, { fetch: async () => new Response('<h1>', { status: 502 }) })
    await expect(html.request('GET', '/x')).rejects.toThrow('admin API answered HTTP 502')
    const odd = createAdminClient(target, { fetch: async () => Response.json({ rooms: 'x' }) })
    await expect(findRoomVia(odd)).rejects.toThrow('unexpected admin API response (rooms)')
  })
})

async function findRoomVia(client: ReturnType<typeof createAdminClient>) {
  const { listRooms } = await import('../src/commands/admin-rooms')
  return findRoom(await listRooms(client), 'x')
}

describe('agent-peers hub rotate-admin-token', () => {
  it('rotates through the running hub', async () => {
    const before = await readAdminToken(hub.dataDir)
    const result = await run('hub', 'rotate-admin-token')
    expect(result.code).toBe(0)
    expect(result.out).toContain('browsers signed in to /admin were signed out.')
    const after = await readAdminToken(hub.dataDir)
    expect(after).not.toBe(before)
    expect((await run('rooms')).code).toBe(0)
  })

  it('rotates in the database when no hub is running', async () => {
    const other = await startHubCli()
    const before = await readAdminToken(other.dataDir)
    expect(await other.stop()).toBe(0)
    const result = await runCli(['hub', 'rotate-admin-token', '--json'], other.env)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ path: join(other.dataDir, 'admin-token'), live: false })
    expect(await readAdminToken(other.dataDir)).not.toBe(before)
    await other.cleanup()
  })

  it('refuses a data dir without a hub', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apa-'))
    const result = await runCli(['hub', '--data-dir', dir, 'rotate-admin-token'], { HOME: dir })
    expect(result.code).toBe(2)
    expect(result.err).toContain(`no hub data in ${dir}`)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('output helpers', () => {
  it('formats the room table and invite lines', () => {
    expect(roomTable([])).toEqual(['no rooms yet: agent-peers invite <room> --create'])
    const row = {
      room_id: 'r1',
      name: 'payments',
      display_name: undefined,
      people: 2,
      agents: 3,
      open_asks: 1,
      pending_knocks: 0,
      last_activity_at: null,
      invite: null,
    }
    expect(roomTable([row])).toEqual([
      'ROOM      PEOPLE  AGENTS  ASKS  KNOCKS  INVITE',
      'payments  2       3       1     0       closed',
    ])
    expect(inviteAction({})).toBe('show')
    expect(inviteAction({ reopen: true })).toBe('reopen')
    expect(inviteLines({ room: 'a', room_id: 'r', action: 'close', closed: true })[0]).toContain('closed')
    expect(() => findRoom([row], 'nope')).toThrow('no room "nope" on this hub (rooms: payments)')
    expect(findRoom([row], 'PAYMENTS').room_id).toBe('r1')
    expect(findRoom([row], 'r1').name).toBe('payments')
  })
})
