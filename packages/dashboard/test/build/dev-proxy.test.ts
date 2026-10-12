import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { DEFAULT_HUB_URL, isHubPath, parseHubUrl, proxyToHub, toHubRequest } from '../../scripts/dev-proxy'

describe('dev proxy routing', () => {
  it('sends the member API and login page to the hub', () => {
    expect(isHubPath('/v0/me/sessions')).toBe(true)
    expect(isHubPath('/v0/rooms/search')).toBe(true)
    expect(isHubPath('/app/login')).toBe(true)
    expect(isHubPath('/app/rooms')).toBe(false)
    expect(isHubPath('/app/')).toBe(false)
  })
  it('parses PEERS_HUB_URL', () => {
    expect(parseHubUrl(undefined).href).toBe(`${DEFAULT_HUB_URL}/`)
    expect(parseHubUrl('  ').href).toBe(`${DEFAULT_HUB_URL}/`)
    expect(parseHubUrl('https://hub.example.com').origin).toBe('https://hub.example.com')
    expect(() => parseHubUrl('not a url')).toThrow('not a valid URL')
    expect(() => parseHubUrl('ftp://x')).toThrow('must be http(s)')
  })
  it('rewrites the URL and the Origin onto the hub', () => {
    const hub = new URL('http://127.0.0.1:7300')
    const req = new Request('http://localhost:5173/v0/me/sessions/s1?x=1', {
      method: 'PATCH',
      headers: {
        origin: 'http://localhost:5173',
        cookie: 'ap_member=abc',
        'content-type': 'application/json',
      },
      body: '{"accepting":false}',
    })
    const out = toHubRequest(req, hub)
    expect(out.url).toBe('http://127.0.0.1:7300/v0/me/sessions/s1?x=1')
    expect(out.method).toBe('PATCH')
    expect(out.headers.get('origin')).toBe('http://127.0.0.1:7300')
    expect(out.headers.get('cookie')).toBe('ap_member=abc')
    const get = toHubRequest(new Request('http://localhost:5173/v0/me'), hub)
    expect(get.headers.has('origin')).toBe(false)
  })
  it('never launders a foreign Origin into the hub’s (the hub’s CSRF guard must still see it)', () => {
    const hub = new URL('http://127.0.0.1:7300')
    for (const origin of ['http://localhost:3000', 'http://evil.example', 'null']) {
      const out = toHubRequest(
        new Request('http://localhost:5173/v0/me/rooms/r_1/exit', { method: 'POST', headers: { origin } }),
        hub,
      )
      expect(out.headers.get('origin')).toBe(origin)
    }
  })
})

describe('proxyToHub', () => {
  let hub: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    hub = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = req.method === 'POST' ? await req.text() : ''
        return Response.json({ path: new URL(req.url).pathname, origin: req.headers.get('origin'), body })
      },
    })
  })
  afterAll(() => hub.stop(true))

  it('forwards requests and bodies', async () => {
    const hubUrl = new URL(hub.url.href)
    const res = await proxyToHub(
      new Request('http://localhost:5173/app/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
        body: 'c=1',
      }),
      hubUrl,
    )
    expect(await res.json()).toEqual({ path: '/app/login', origin: hubUrl.origin, body: 'c=1' })
  })
  it('answers 502 with an error body when the hub is down', async () => {
    const down = Bun.serve({ port: 0, fetch: () => new Response('') })
    const url = new URL(down.url.href)
    down.stop(true)
    const res = await proxyToHub(new Request('http://localhost:5173/v0/me'), url)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unavailable')
    expect(body.error.message).toContain('unreachable')
  })
})
