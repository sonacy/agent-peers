import { afterEach, describe, expect, it } from 'bun:test'
import { caller, cookiePair, errorCode, type HttpHub, jsonOf, signIn, startHttpHub } from './support'

let h: HttpHub | undefined

afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function loginLink(hub: HttpHub, name: string) {
  const issued = hub.hub.services.members.create(name)
  const client = await hub.client(issued.token)
  const { session_id } = await client.open(`${name}-k`)
  return client.request<{ code: string; url: string }>('dashboard.login', { session_id })
}

describe('member sign-in (/app/login)', () => {
  it('GET renders only a Continue form, escapes the code and never consumes it', async () => {
    h = await startHttpHub()
    const link = await loginLink(h, 'alice')
    expect(link.url).toBe(`${h.base}/app/login?c=${link.code}`)
    const res = await fetch(link.url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    const page = await res.text()
    expect(page).toContain('Continue')
    expect(page).toContain(`value="${link.code}"`)
    expect(page).not.toContain('<script')
    const evil = await (
      await fetch(`${h.base}/app/login?c=${encodeURIComponent('"><script>x</script>')}`)
    ).text()
    expect(evil).not.toContain('<script>x')
    expect(evil).toContain('&quot;&gt;&lt;script&gt;')
    expect(await (await fetch(`${h.base}/app/login`)).text()).toContain('/peers:dashboard')
    // The GET did not burn the code: the POST still works.
    const post = await caller(h.base).post('/app/login', { code: link.code })
    expect(post.status).toBe(200)
  })

  it('POST checks Origin, sets a strict HttpOnly 7-day cookie and is single use', async () => {
    h = await startHttpHub()
    const link = await loginLink(h, 'alice')
    const noOrigin = await caller(h.base, undefined, null).post('/app/login', { code: link.code })
    expect(noOrigin.status).toBe(403)
    const foreign = await caller(h.base, undefined, 'https://evil.example').post('/app/login', {
      code: link.code,
    })
    expect(foreign.status).toBe(403)
    expect(await errorCode(foreign)).toBe('forbidden')

    const ok = await caller(h.base).post('/app/login', { code: link.code })
    expect(ok.status).toBe(200)
    const body = await jsonOf<{ ok: boolean; member: { name: string } }>(ok)
    expect(body.member.name).toBe('alice')
    const cookie = ok.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('ap_member=apw_')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${7 * 24 * 3600}`)
    expect(cookie).not.toContain('Secure')

    const again = await caller(h.base).post('/app/login', { code: link.code })
    expect(again.status).toBe(401)
    expect(await errorCode(again)).toBe('unauthorized')
  })

  it('accepts the HTML form post and redirects to the dashboard', async () => {
    h = await startHttpHub()
    const link = await loginLink(h, 'alice')
    const res = await fetch(`${h.base}/app/login`, {
      method: 'POST',
      headers: { origin: h.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${link.code}`,
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/app/')
    expect(cookiePair(res)).toStartWith('ap_member=')
    const bad = await fetch(`${h.base}/app/login`, {
      method: 'POST',
      headers: { origin: h.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${link.code}`,
    })
    expect(bad.status).toBe(401)
    expect(await bad.text()).toContain('/peers:dashboard')
    const empty = await fetch(`${h.base}/app/login`, {
      method: 'POST',
      headers: { origin: h.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect(empty.status).toBe(400)
  })

  it('marks the cookie Secure when the public URL is https', async () => {
    h = await startHttpHub({ publicUrl: 'https://hub.example.com' })
    const link = await loginLink(h, 'alice')
    const res = await caller(h.base, undefined, 'https://hub.example.com').post('/app/login', {
      code: link.code,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('logout ends the web session and clears the cookie', async () => {
    h = await startHttpHub()
    const alice = await signIn(h, 'alice')
    expect((await alice.api.get('/v0/me')).status).toBe(200)
    const crossSite = await caller(h.base, alice.cookie, null).post('/v0/me/logout')
    expect(crossSite.status).toBe(403)
    const out = await alice.api.post('/v0/me/logout')
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await alice.api.get('/v0/me')).status).toBe(401)
    expect((await caller(h.base).post('/v0/me/logout')).status).toBe(200)
  })

  it('rate-limits login attempts per IP', async () => {
    h = await startHttpHub({ http: { rateLimits: { login: 2 } } })
    const api = caller(h.base)
    expect((await api.post('/app/login', { code: 'NOPE' })).status).toBe(401)
    expect((await api.post('/app/login', { code: 'NOPE' })).status).toBe(401)
    const limited = await api.post('/app/login', { code: 'NOPE' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await errorCode(limited)).toBe('rate_limited')
  })

  it('behind a trusted proxy, keys rate limits by X-Forwarded-For and honours X-Forwarded-Proto', async () => {
    h = await startHttpHub({ http: { trustProxy: true, rateLimits: { login: 1 } } })
    // The proxy appends the real peer on the right; anything to its left is client-supplied.
    const from = (ip: string, forged = '198.51.100.7') => ({
      headers: { 'x-forwarded-for': `${forged}, ${ip}` },
    })
    const api = caller(h.base)
    expect((await api.post('/app/login', { code: 'NOPE' }, from('203.0.113.1'))).status).toBe(401)
    expect((await api.post('/app/login', { code: 'NOPE' }, from('203.0.113.1', '1.2.3.4'))).status).toBe(429)
    expect((await api.post('/app/login', { code: 'NOPE' }, from('203.0.113.2'))).status).toBe(401)
    const link = await loginLink(h, 'alice')
    const secure = await api.post(
      '/app/login',
      { code: link.code },
      { headers: { 'x-forwarded-for': '203.0.113.3', 'x-forwarded-proto': 'https' } },
    )
    expect(secure.headers.get('set-cookie')).toContain('Secure')
  })
})
