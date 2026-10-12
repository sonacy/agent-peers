import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADMIN } from '../../src/services/access'
import { caller, errorCode, type HttpHub, jsonOf, startHttpHub } from './support'

let h: HttpHub | undefined
const dirs: string[] = []

afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function roomWithCode(hub: HttpHub, input: { name: string; display_name?: string; description?: string }) {
  const created = hub.hub.services.rooms.create(ADMIN, input)
  const invite = hub.hub.services.deps.repos.invites.active(created.room_id)
  const code = invite ? hub.hub.services.invites.codeFor(invite) : undefined
  if (!code) throw new Error('no invite code')
  return { roomId: created.room_id, code }
}

describe('GET /install.sh', () => {
  it('is a POSIX sh script pinned to the hub version that verifies SHA256SUMS and execs the binary', async () => {
    h = await startHttpHub({ version: '1.2.3' })
    const res = await fetch(`${h.base}/install.sh`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/x-shellscript')
    const script = await res.text()
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('VERSION="1.2.3"')
    expect(script).toContain('REPO="sonacy/agent-peers"')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variables, not a template
    expect(script).toContain('https://github.com/${REPO}/releases/download/v${VERSION}')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variables, not a template
    expect(script).toContain('asset="agent-peers-${os}-${arch}"')
    expect(script).toContain('uname -s')
    expect(script).toContain('uname -m')
    expect(script).toContain('SHA256SUMS')
    expect(script).toContain('checksum mismatch')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variables, not a template
    expect(script).toContain('exec "${tmp}/${asset}" "$@"')
    expect(script.trimEnd().endsWith('main "$@"')).toBe(true)
    const dir = await mkdtemp(join(tmpdir(), 'agent-peers-install-'))
    dirs.push(dir)
    await writeFile(join(dir, 'install.sh'), script)
    const check = Bun.spawnSync(['sh', '-n', join(dir, 'install.sh')])
    expect(check.exitCode).toBe(0)
  })

  it('uses the configured release repo', async () => {
    h = await startHttpHub({ http: { releaseRepo: 'acme/peers-fork' } })
    expect(await (await fetch(`${h.base}/install.sh`)).text()).toContain('REPO="acme/peers-fork"')
  })

  it('refuses a release repo that is not owner/name', async () => {
    await expect(startHttpHub({ http: { releaseRepo: 'x"; rm -rf /' } })).rejects.toThrow('owner/name')
  })
})

describe('GET /j/<code> landing page', () => {
  it('renders the room, inviter and join prompt with every value escaped', async () => {
    h = await startHttpHub()
    const { code } = roomWithCode(h, {
      name: 'payments',
      display_name: '<script>alert(1)</script>',
      description: '"><img src=x onerror=alert(2)>',
    })
    const res = await fetch(`${h.base}/j/${code}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    expect(res.headers.get('cache-control')).toBe('no-store')
    const page = await res.text()
    expect(page).not.toContain('<script>')
    expect(page).not.toContain('<img')
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;')
    expect(page).toContain(`${h.base}/install.sh | sh -s -- join ${h.base}/j/${code} --here`)
    expect(page).toContain('Invited by admin')
    const lower = await (await fetch(`${h.base}/j/${code.toLowerCase()}`)).text()
    expect(lower).toContain(`/j/${code}`)
  })

  it('renders the Chinese prompt for zh browsers', async () => {
    h = await startHttpHub()
    const { code } = roomWithCode(h, { name: 'payments' })
    const page = await (
      await fetch(`${h.base}/j/${code}`, { headers: { 'accept-language': 'zh-CN,zh' } })
    ).text()
    expect(page).toContain('npm')
    expect(page).toMatch(/[一-鿿]/)
  })

  it('explains unknown, rotated and closed invites without leaking anything', async () => {
    h = await startHttpHub()
    const { roomId, code } = roomWithCode(h, { name: 'payments' })
    const unknown = await fetch(`${h.base}/j/AAAAAAAAAAAAAAAA`)
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).toContain('Invite not found')
    expect((await fetch(`${h.base}/j/<script>`)).status).toBe(404)
    h.hub.services.invites.rotate(ADMIN, roomId)
    expect((await fetch(`${h.base}/j/${code}`)).status).toBe(404)
    h.hub.services.invites.close(ADMIN, roomId)
    const closed = await fetch(`${h.base}/j/${code}`)
    expect(closed.status).toBe(410)
    expect(await closed.text()).toContain('Invites are closed')
  })

  it('says so when the hub has no public URL', async () => {
    h = await startHttpHub({ publicUrl: 'https://hub.example.com' })
    const { code } = roomWithCode(h, { name: 'payments' })
    h.hub.runtime.publicUrl = undefined
    const page = await (await fetch(`${h.base}/j/${code}`)).text()
    expect(page).toContain('no public URL')
    expect(page).not.toContain('install.sh')
  })
})

describe('invite preview and redeem', () => {
  it('previews an invite without side effects', async () => {
    h = await startHttpHub({ version: '0.4.0', http: { hubName: 'Team hub' } })
    const { roomId, code } = roomWithCode(h, { name: 'payments', description: 'the payments team' })
    const res = await fetch(`${h.base}/v0/invites/${code}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      hub_name: 'Team hub',
      room: { room_id: roomId, name: 'payments' },
      description: 'the payments team',
      inviter: 'admin',
      expires_at: null,
      uses_left: null,
      cli_version: '0.4.0',
    })
    const missing = await fetch(`${h.base}/v0/invites/AAAAAAAAAAAAAAAA`)
    expect(missing.status).toBe(404)
    expect(await errorCode(missing)).toBe('invite_invalid')
    expect(await errorCode(await fetch(`${h.base}/v0/invites/short`))).toBe('invite_invalid')
  })

  it('names the hub after the public URL host by default', async () => {
    h = await startHttpHub()
    const { code } = roomWithCode(h, { name: 'payments' })
    const body = await jsonOf<{ hub_name: string }>(await fetch(`${h.base}/v0/invites/${code}`))
    expect(body.hub_name).toBe(new URL(h.base).host)
  })

  it('redeems as a new member (suffixing a taken name) and with an existing token', async () => {
    h = await startHttpHub()
    const { roomId, code } = roomWithCode(h, { name: 'payments' })
    h.hub.services.members.create('alice')
    const api = caller(h.base, undefined, null)
    const res = await api.post('/v0/invites/redeem', { code, member_name: 'alice' })
    expect(res.status).toBe(201)
    const body = await jsonOf<{
      member_token: string
      member: { name: string }
      renamed: boolean
      grant: { room_id: string; member: string; role: string }
    }>(res)
    expect(body.member_token).toStartWith('apm_')
    expect(body.member.name).toBe('alice-2')
    expect(body.renamed).toBe(true)
    expect(body.grant).toEqual({ room_id: roomId, member: 'alice-2', role: 'member' })
    expect(h.hub.services.members.authenticate(body.member_token)?.name).toBe('alice-2')

    const bob = h.hub.services.members.create('bob')
    const withToken = await api.post(
      '/v0/invites/redeem',
      { code },
      { headers: { authorization: `Bearer ${bob.token}` } },
    )
    expect(withToken.status).toBe(200)
    const granted = await jsonOf<{ member: { name: string }; grant: { role: string } }>(withToken)
    expect(granted.member.name).toBe('bob')
    expect(granted.grant.role).toBe('member')
    expect(h.hub.services.access.activeGrant(roomId, bob.member.id)).toBeDefined()

    const badToken = await api.post(
      '/v0/invites/redeem',
      { code },
      { headers: { authorization: 'Bearer apm_nope_nope' } },
    )
    expect(badToken.status).toBe(401)
    expect(await errorCode(await api.post('/v0/invites/redeem', { code }))).toBe('invalid_params')
    expect(await errorCode(await api.post('/v0/invites/redeem', { code, member_name: 'Bad Name' }))).toBe(
      'invalid_name',
    )
  })

  it('validates bodies: JSON content type, syntax and size', async () => {
    h = await startHttpHub()
    const raw = (body: string, type = 'application/json') =>
      fetch(`${h?.base}/v0/invites/redeem`, { method: 'POST', headers: { 'content-type': type }, body })
    expect(await errorCode(await raw('{nope'))).toBe('parse_error')
    expect(await errorCode(await raw('code=x', 'text/plain'))).toBe('invalid_request')
    expect(await errorCode(await raw(''))).toBe('invalid_request')
    const huge = await raw(JSON.stringify({ code: 'x'.repeat(70_000) }))
    expect(huge.status).toBe(413)
  })

  it('refuses a closed invite and rate-limits redeems per IP', async () => {
    h = await startHttpHub({ http: { rateLimits: { redeem: 3 } } })
    const { roomId, code } = roomWithCode(h, { name: 'payments' })
    h.hub.services.invites.close(ADMIN, roomId)
    const api = caller(h.base, undefined, null)
    const closed = await api.post('/v0/invites/redeem', { code, member_name: 'carol' })
    expect(closed.status).toBe(410)
    expect(await errorCode(closed)).toBe('invite_closed')
    await api.post('/v0/invites/redeem', { code, member_name: 'carol' })
    await api.post('/v0/invites/redeem', { code, member_name: 'carol' })
    const limited = await api.post('/v0/invites/redeem', { code, member_name: 'carol' })
    expect(limited.status).toBe(429)
    expect(await errorCode(limited)).toBe('rate_limited')
  })

  it('refuses a foreign Origin even on public endpoints', async () => {
    h = await startHttpHub()
    const { code } = roomWithCode(h, { name: 'payments' })
    const res = await caller(h.base, undefined, 'https://evil.example').post('/v0/invites/redeem', {
      code,
      member_name: 'mallory',
    })
    expect(res.status).toBe(403)
    const nullOrigin = await caller(h.base, undefined, 'null').post('/v0/invites/redeem', {
      code,
      member_name: 'm',
    })
    expect(nullOrigin.status).toBe(403)
  })
})

describe('POST /v0/members/register', () => {
  it('is refused on an invite-only hub', async () => {
    h = await startHttpHub()
    const res = await caller(h.base, undefined, null).post('/v0/members/register', { member_name: 'dave' })
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe('forbidden')
  })

  it('registers on an open hub, refuses taken names and rate-limits per IP', async () => {
    h = await startHttpHub({ registration: 'open', http: { rateLimits: { register: 3 } } })
    const api = caller(h.base, undefined, null)
    const res = await api.post('/v0/members/register', { member_name: 'dave' })
    expect(res.status).toBe(201)
    const body = await jsonOf<{ member_token: string; member: { name: string } }>(res)
    expect(body.member.name).toBe('dave')
    expect(h.hub.services.members.authenticate(body.member_token)?.name).toBe('dave')
    expect(await errorCode(await api.post('/v0/members/register', { member_name: 'dave' }))).toBe(
      'invalid_name',
    )
    expect(await errorCode(await api.post('/v0/members/register', { member_name: '' }))).toBe('invalid_name')
    expect((await api.post('/v0/members/register', { member_name: 'erin' })).status).toBe(429)
  })
})

describe('fallbacks', () => {
  it('answers unknown API paths with a JSON 404 and other paths with text', async () => {
    h = await startHttpHub()
    const api = await fetch(`${h.base}/v0/nope`)
    expect(api.status).toBe(404)
    expect(await errorCode(api)).toBe('method_not_found')
    const other = await fetch(`${h.base}/nope`)
    expect(other.status).toBe(404)
    expect(other.headers.get('x-content-type-options')).toBe('nosniff')
    const css = await fetch(`${h.base}/_hub/page.css`)
    expect(css.headers.get('content-type')).toContain('text/css')
  })
})
