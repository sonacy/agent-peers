/**
 * Dev-server proxy: forwards the member API (`/v0/*`) and the login page (`/app/login`) to a running
 * hub, so the HMR server and the hub look like one origin to the browser.
 */

export const DEFAULT_HUB_URL = 'http://127.0.0.1:7300'

/** Paths the hub answers; everything else under /app is the SPA. */
export function isHubPath(pathname: string): boolean {
  return pathname.startsWith('/v0/') || pathname === '/app/login' || pathname === '/install.sh'
}

export function parseHubUrl(raw: string | undefined): URL {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_HUB_URL : raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`PEERS_HUB_URL is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`PEERS_HUB_URL must be http(s): ${value}`)
  }
  return url
}

/**
 * Rewrites the request onto the hub. The hub refuses mutations whose Origin doesn't match its Host
 * (its CSRF guard), and the browser sends the dev server's origin, so that one Origin, and only
 * that one, is swapped for the hub's. Any other Origin (another local page posting a form at the
 * dev server) is forwarded unchanged and the hub refuses it, as it would without the proxy.
 */
export function toHubRequest(request: Request, hub: URL): Request {
  const incoming = new URL(request.url)
  const target = new URL(incoming.pathname + incoming.search, hub)
  const headers = new Headers(request.headers)
  headers.delete('host')
  if (headers.get('origin') === incoming.origin) headers.set('origin', hub.origin)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  return new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    signal: request.signal,
  })
}

export async function proxyToHub(request: Request, hub: URL): Promise<Response> {
  try {
    return await fetch(toHubRequest(request, hub))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return Response.json(
      { error: { code: 'unavailable', message: `dev proxy: hub at ${hub.origin} unreachable (${reason})` } },
      { status: 502 },
    )
  }
}
