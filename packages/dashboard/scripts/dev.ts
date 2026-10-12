/** `bun run dev`: the SPA with HMR on PORT (default 5173), proxying the hub at PEERS_HUB_URL. */
import index from '../src/index.html'
import { isHubPath, parseHubUrl, proxyToHub } from './dev-proxy'

const hub = parseHubUrl(process.env.PEERS_HUB_URL)
const port = Number(process.env.PORT ?? 5173)

const server = Bun.serve({
  // Loopback only: the proxy carries the member cookie to a real hub, so keep it off the LAN.
  hostname: '127.0.0.1',
  port,
  development: { hmr: true, console: true },
  idleTimeout: 0, // SSE (`/v0/me/events`) stays open
  routes: {
    '/': Response.redirect('/app/', 302),
    '/app': Response.redirect('/app/', 301),
    '/app/login': (request) => proxyToHub(request, hub),
    '/app/*': index,
  },
  fetch(request) {
    const { pathname } = new URL(request.url)
    if (isHubPath(pathname)) return proxyToHub(request, hub)
    return new Response('not found', { status: 404 })
  },
})

process.stdout.write(`dashboard dev: ${server.url}app/ (hub ${hub.origin})\n`)
