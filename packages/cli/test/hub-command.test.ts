import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAdminToken, readHubState } from '../src/commands/hub-state'
import { type HubCli, runCli, startHubCli } from './helpers/hub-cli'

let current: HubCli | undefined

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

describe('agent-peers hub', () => {
  it('starts on port 0, prints listeners and the bootstrap invite, and stops on SIGINT', async () => {
    current = await startHubCli()
    const { running, dataDir } = current
    expect(running.started.publicPort).toBeGreaterThan(0)
    expect(running.started.adminPort).toBeGreaterThan(0)
    const out = current.out()
    expect(out).toContain('agent-peers hub 0.1.0 (protocol agent-peers/0.3)')
    expect(out).toContain(`data dir         ${dataDir}`)
    expect(out).toContain(`/admin  (sign in with ${join(dataDir, 'admin-token')})`)
    expect(out).toContain('created room "default". Invite link: http://127.0.0.1:')
    expect(out).toContain('Join my agent-peers room "default"')
    expect(out).toContain('dashboard        not built')
    expect(current.err()).toContain('only agents on this machine can join')

    const state = await readHubState(dataDir)
    expect(state?.admin_port).toBe(running.started.adminPort)
    expect(state?.public_url).toBe(`http://127.0.0.1:${running.started.publicPort}`)
    expect((await stat(join(dataDir, 'hub.json'))).mode & 0o777).toBe(0o600)
    expect(await readAdminToken(dataDir)).toMatch(/\S{16,}/)

    expect(await current.stop()).toBe(0)
    expect(current.err()).toContain('SIGINT: stopping the hub')
    expect(existsSync(join(dataDir, 'hub.json'))).toBe(false)
  })

  it('keeps its data across restarts and stops on SIGTERM', async () => {
    const first = await startHubCli()
    const token = await readAdminToken(first.dataDir)
    expect(await first.stop('SIGTERM')).toBe(0)
    current = await startHubCli({ dir: first.dir })
    expect(current.out()).not.toContain('created room')
    expect(current.out()).toContain('mint an invite with: agent-peers invite [room]')
    expect(await readAdminToken(current.dataDir)).toBe(token)
    const rooms = await runCli(['rooms', '--json'], current.env)
    expect(JSON.parse(rooms.out).rooms.map((r: { name: string }) => r.name)).toEqual(['default'])
  })

  it('serves the dashboard assets on /app and /admin when the dashboard is built', async () => {
    const assets = new Map([['index.html', '<!doctype html><title>Peers SPA</title>']])
    current = await startHubCli({ loadDashboard: async () => assets })
    expect(current.out()).toContain('dashboard        embedded')
    const { publicPort, adminPort } = current.running.started
    const app = await fetch(`http://127.0.0.1:${publicPort}/app/`)
    expect(await app.text()).toContain('Peers SPA')
    const admin = await fetch(`http://127.0.0.1:${adminPort}/admin/`)
    expect(await admin.text()).toContain('Peers SPA')
  })

  it('warns that a wildcard bind without --public-url cannot mint invites', async () => {
    current = await startHubCli({ args: ['--bind', '0.0.0.0'] })
    expect(current.running.started.publicUrl).toBeUndefined()
    expect(current.err()).toContain('without --public-url, so it refuses to mint invites')
    expect(current.out()).not.toContain('Invite link')
    const invite = await runCli(['invite'], current.env)
    expect(invite.code).toBe(5)
    expect(invite.err).toContain('[forbidden]')
  })

  it('uses --public-url for invite links and prints JSON with --json', async () => {
    current = await startHubCli({ args: ['--public-url', 'https://hub.example.com/', '--json'] })
    const report = JSON.parse(current.out().split('\n')[0] ?? '{}')
    expect(report.publicUrl).toBe('https://hub.example.com')
    expect(report.bootstrap.inviteUrl).toStartWith('https://hub.example.com/j/')
    expect(report.warnings).toEqual([])
    expect(await current.stop()).toBe(0)
    expect(current.err()).not.toContain('stopping the hub')
  })

  it('fails cleanly when a port is taken or a flag is invalid', async () => {
    current = await startHubCli()
    const dir = await mkdtemp(join(tmpdir(), 'aph-'))
    const env = { HOME: dir, AGENT_PEERS_HOME: join(dir, 'peers') }
    const port = String(current.running.started.publicPort)
    const taken = await runCli(['hub', '--bind', '127.0.0.1', '--port', port, '--admin-port', '0'], env)
    expect(taken.code).toBe(1)
    expect(taken.err).toContain('agent-peers:')
    const badUrl = await runCli(['hub', '--public-url', 'ftp://x'], env)
    expect(badUrl.code).toBe(2)
    expect(badUrl.err).toContain('--public-url must start with http')
    const badPort = await runCli(['hub', '--port', '70000'], env)
    expect(badPort.code).toBe(2)
    expect(badPort.err).toContain('expected a port number')
    const badMode = await runCli(['hub', '--registration', 'closed'], env)
    expect(badMode.code).toBe(2)
    await rm(dir, { recursive: true, force: true })
  })
})
