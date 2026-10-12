/**
 * SPA serving for `/app/*` and `/admin/*`: files from a directory or an injected asset map, with an
 * `index.html` fallback for client-side routes. Paths that look like files and don't exist get 404.
 */
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { html, htmlResponse, page } from './html'
import type { AssetBody, AssetMap, StaticSource } from './types'

const INDEX = 'index.html'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** The path below the mount, or undefined when it tries to escape (`..`, backslashes, NUL). */
export function relativeAssetPath(pathname: string, mount: string): string | undefined {
  const rest = pathname.startsWith(mount) ? pathname.slice(mount.length) : pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return undefined
  }
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..' || s.includes('\\') || s.includes('\0'))) return undefined
  return segments.join('/')
}

function lookupAsset(assets: AssetMap, path: string): AssetBody | undefined {
  if (assets instanceof Map) return assets.get(path)
  const record = assets as Readonly<Record<string, AssetBody>>
  return Object.hasOwn(record, path) ? record[path] : undefined
}

async function lookupFile(dir: string, path: string): Promise<Blob | undefined> {
  const root = resolve(dir)
  const full = resolve(join(root, path))
  if (full !== root && !full.startsWith(root + sep)) return undefined
  try {
    const info = await stat(full)
    return info.isFile() ? Bun.file(full) : undefined
  } catch {
    return undefined
  }
}

async function find(source: StaticSource, path: string): Promise<AssetBody | undefined> {
  if (source.assets !== undefined) {
    const asset = lookupAsset(source.assets, path)
    if (asset !== undefined) return asset
  }
  return source.dir === undefined ? undefined : lookupFile(source.dir, path)
}

function assetResponse(body: AssetBody, path: string): Response {
  const isHtml = extname(path).toLowerCase() === '.html'
  return new Response(body, {
    headers: {
      'content-type': contentTypeFor(path),
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
    },
  })
}

function placeholder(title: string): Response {
  return htmlResponse(
    page(
      title,
      html`<h1>${title}</h1><p class="muted">The dashboard is not bundled into this build of the hub.</p>`,
    ),
  )
}

/** Serves `pathname` below `mount` from `source`, falling back to `index.html` for SPA routes. */
export async function serveSpa(
  source: StaticSource | undefined,
  mount: string,
  pathname: string,
  title: string,
): Promise<Response> {
  const path = relativeAssetPath(pathname, mount)
  if (path === undefined) return new Response('not found', { status: 404 })
  if (source === undefined) return placeholder(title)
  const target = path === '' ? INDEX : path
  const asset = await find(source, target)
  if (asset !== undefined) return assetResponse(asset, target)
  if (target !== INDEX && extname(target) !== '') return new Response('not found', { status: 404 })
  const index = await find(source, INDEX)
  return index === undefined ? placeholder(title) : assetResponse(index, INDEX)
}
