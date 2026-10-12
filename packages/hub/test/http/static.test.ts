import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentTypeFor, relativeAssetPath } from '../../src/http/static'
import { type HttpHub, startHttpHub } from './support'

let h: HttpHub | undefined
const dirs: string[] = []

afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function dashboardDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-peers-static-'))
  dirs.push(root)
  const dir = join(root, 'dist')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Peers</title><div id="root"></div>')
  await writeFile(join(dir, 'assets', 'app.js'), 'console.info("app")')
  await writeFile(join(root, 'secret.txt'), 'outside the dashboard')
  return dir
}

describe('member SPA under /app', () => {
  it('serves files from a directory with an index.html fallback for client routes', async () => {
    h = await startHttpHub({ http: { dashboard: { dir: await dashboardDir() } } })
    const redirect = await fetch(`${h.base}/app`, { redirect: 'manual' })
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('/app/')
    const index = await fetch(`${h.base}/app/`)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    expect(index.headers.get('cache-control')).toBe('no-cache')
    expect(await index.text()).toContain('id="root"')
    const route = await fetch(`${h.base}/app/rooms/01ABC`)
    expect(await route.text()).toContain('id="root"')
    const js = await fetch(`${h.base}/app/assets/app.js`)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(await js.text()).toContain('app')
    expect((await fetch(`${h.base}/app/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${h.base}/app/assets`)).status).toBe(200)
  })

  it('never serves files outside the dashboard directory', async () => {
    h = await startHttpHub({ http: { dashboard: { dir: await dashboardDir() } } })
    for (const path of [
      '/app/..%2fsecret.txt',
      '/app/%2e%2e/secret.txt',
      '/app/a%5c..%5csecret.txt',
      '/app/%E0%A4%A',
    ]) {
      const res = await fetch(`${h.base}${path}`)
      expect(await res.text()).not.toContain('outside the dashboard')
    }
  })

  it('serves an injected asset map (Map or record) and falls back to a placeholder', async () => {
    const assets = new Map<string, string>([
      ['index.html', '<!doctype html><p>embedded</p>'],
      ['assets/a.css', 'body{}'],
    ])
    h = await startHttpHub({
      http: { dashboard: { assets }, admin: { assets: { 'index.html': '<p>operator</p>' } } },
    })
    expect(await (await fetch(`${h.base}/app/knocks`)).text()).toContain('embedded')
    expect((await fetch(`${h.base}/app/assets/a.css`)).headers.get('content-type')).toContain('text/css')
    expect(await (await fetch(`${h.adminBase}/admin/rooms`)).text()).toContain('operator')
    await h.stop()

    h = await startHttpHub({ http: { dashboard: { assets: { 'assets/x.js': '1' } } } })
    const placeholder = await fetch(`${h.base}/app/`)
    expect(placeholder.status).toBe(200)
    expect(await placeholder.text()).toContain('not bundled')
  })

  it('shows a placeholder when no dashboard is configured, on both listeners', async () => {
    h = await startHttpHub()
    expect(await (await fetch(`${h.base}/app/`)).text()).toContain('not bundled')
    const admin = await fetch(`${h.adminBase}/admin/`)
    expect(admin.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    expect(await admin.text()).toContain('Peers operator')
    const root = await fetch(`${h.adminBase}/`, { redirect: 'manual' })
    expect(root.headers.get('location')).toBe('/admin/')
    expect((await fetch(`${h.adminBase}/admin`, { redirect: 'manual' })).status).toBe(301)
    expect((await fetch(`${h.adminBase}/_hub/page.css`)).headers.get('content-type')).toContain('text/css')
  })
})

describe('static helpers', () => {
  it('normalizes asset paths and refuses traversal', () => {
    expect(relativeAssetPath('/app/', '/app')).toBe('')
    expect(relativeAssetPath('/app/./assets//a.js', '/app')).toBe('assets/a.js')
    expect(relativeAssetPath('/app/../x', '/app')).toBeUndefined()
    expect(relativeAssetPath('/app/%2e%2e/x', '/app')).toBeUndefined()
    expect(relativeAssetPath('/app/%zz', '/app')).toBeUndefined()
    expect(relativeAssetPath('/other/a', '/app')).toBe('other/a')
  })

  it('maps content types by extension', () => {
    expect(contentTypeFor('a.woff2')).toBe('font/woff2')
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream')
  })
})
