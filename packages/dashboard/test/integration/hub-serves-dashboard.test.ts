/**
 * Integration: a real hub serving the embedded dashboard the way the CLI wires it (the same asset map
 * for `/app` and `/admin`). The SPA is built into a temp dir and its generated module imported, so
 * the map is exactly what `dashboardAssets()` returns after `bun run build`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { createHub, type Hub, silentLogger } from '@agent-peers/hub'
import { type DashboardAssetMap, type EmbeddedAssetList, toAssetMap } from '../../src/index'

const PACKAGE_DIR = join(import.meta.dir, '..', '..')

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}

let work: string
let assets: DashboardAssetMap
let hub: Hub
let app: string
let admin: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'peers-serve-'))
  const moduleFile = join(work, 'gen', 'assets.ts')
  const proc = Bun.spawnSync(
    [
      process.execPath,
      join(PACKAGE_DIR, 'scripts', 'build.ts'),
      '--outdir',
      join(work, 'dist'),
      '--module',
      moduleFile,
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  )
  if (proc.exitCode !== 0) throw new Error(`build failed: ${proc.stderr.toString()}`)
  const generated = (await import(moduleFile)) as { EMBEDDED_ASSETS: EmbeddedAssetList }
  const map = toAssetMap(generated.EMBEDDED_ASSETS)
  if (map === undefined) throw new Error('the build embedded nothing')
  assets = map
  hub = createHub({
    publicBind: '127.0.0.1',
    publicPort: 0,
    adminPort: 0,
    dataDir: ':memory:',
    bootstrapDefaultRoom: false,
    logger: silentLogger,
    http: { dashboard: { assets }, admin: { assets } },
  })
  const info = await hub.start()
  app = `http://127.0.0.1:${info.publicPort}`
  admin = `http://127.0.0.1:${info.adminPort}`
}, 120_000)

afterAll(async () => {
  await hub?.stop()
  await rm(work, { recursive: true, force: true })
})

const BUNDLE_URL = /\/app\/[\w.-]+\.(?:js|css|svg|woff2)/g

/** `/app/…` URLs the page loads: from the HTML, plus those its scripts and styles name (fonts). */
async function referencedFiles(html: string): Promise<readonly string[]> {
  const fromHtml = [...html.matchAll(BUNDLE_URL)].map((m) => m[0])
  const nested = await Promise.all(
    fromHtml
      .filter((path) => path.endsWith('.js') || path.endsWith('.css'))
      .map(async (path) =>
        [...(await (await fetch(`${app}${path}`)).text()).matchAll(BUNDLE_URL)].map((m) => m[0]),
      ),
  )
  return [...new Set([...fromHtml, ...nested.flat()])]
}

describe('hub serves the embedded dashboard', () => {
  it('serves index.html at /app/ with the CSP and no-cache', async () => {
    const redirect = await fetch(`${app}/app`, { redirect: 'manual' })
    expect([redirect.status, redirect.headers.get('location')]).toEqual([301, '/app/'])
    const res = await fetch(`${app}/app/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    const html = await res.text()
    expect(html).toContain('<div id="root"></div>')
    expect(html).toBe((await assets.get('index.html')?.text()) ?? 'missing index.html')
  })

  it('serves every bundled file with its content type', async () => {
    const files = [...assets.keys()]
    expect(files.some((f) => f.endsWith('.woff2'))).toBe(true)
    for (const file of files) {
      const res = await fetch(`${app}/app/${file}`)
      expect(res.status).toBe(200)
      const expected = TYPES[extname(file)]
      if (expected !== undefined) expect(res.headers.get('content-type')).toContain(expected)
      if (!file.endsWith('.html')) expect(res.headers.get('cache-control')).toContain('max-age')
    }
  })

  it('falls back to index.html for client routes, never for missing files', async () => {
    for (const path of ['/app/rooms', '/app/rooms/01ROOM', '/app/asks', '/app/login?c=x']) {
      const res = await fetch(`${app}${path}`)
      if (path.startsWith('/app/login')) continue // the hub's own login handler answers GETs here
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('<div id="root"></div>')
    }
    expect((await fetch(`${app}/app/chunk-missing.js`)).status).toBe(404)
    expect((await fetch(`${app}/app/..%2f..%2fpackage.json`)).status).toBe(404)
  })

  it('serves the operator page at /admin and every file it loads from the admin listener', async () => {
    const redirect = await fetch(`${admin}/admin`, { redirect: 'manual' })
    expect([redirect.status, redirect.headers.get('location')]).toEqual([301, '/admin/'])
    for (const path of ['/admin/', '/admin/rooms', '/admin/anything/deep']) {
      const res = await fetch(`${admin}${path}`)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('content-security-policy')).toStartWith("default-src 'self'")
    }
    const html = await (await fetch(`${admin}/admin/`)).text()
    const files = await referencedFiles(html)
    expect(files.some((f) => f.endsWith('.js'))).toBe(true)
    expect(files.some((f) => f.endsWith('.css'))).toBe(true)
    expect(files.some((f) => f.endsWith('.woff2'))).toBe(true)
    for (const path of files) {
      const res = await fetch(`${admin}${path}`)
      expect(res.status).toBe(200)
      const expected = TYPES[extname(path)]
      if (expected !== undefined) expect(res.headers.get('content-type')).toContain(expected)
    }
    expect((await fetch(`${admin}/app/`)).status).toBe(404)
  })
})
