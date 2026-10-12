/**
 * The Playwright fixture server (run with Bun by the global setup): builds the dashboard once into a
 * temp dir, then serves a small JSON control API on a free loopback port that creates seeded demo
 * hubs, mints sign-in links, renames agents and stops/restarts hubs. Prints `{"control": url}` once
 * it is ready, and cleans everything up on SIGTERM/SIGINT.
 */
import { buildToTemp } from '../../../packages/dashboard/scripts/demo/hub'
import type { CreateHubRequest, LoginRequest, TitleRequest } from './contract'
import { HubPool } from './hubs'

const built = await buildToTemp()
const pool = new HubPool(built.source)

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

async function readJson<T>(req: Request): Promise<Partial<T>> {
  const text = await req.text()
  return text === '' ? {} : (JSON.parse(text) as Partial<T>)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

async function hubAction(id: string, action: string, req: Request): Promise<Response> {
  switch (action) {
    case 'login': {
      const body = await readJson<LoginRequest>(req)
      return json({ url: await pool.login(id, required(body.member, 'member')) })
    }
    case 'title': {
      const body = await readJson<TitleRequest>(req)
      await pool.setTitle(id, required(body.agent, 'agent'), required(body.title, 'title'))
      return json({ ok: true })
    }
    case 'stop':
      await pool.stop(id)
      return json({ ok: true })
    case 'restart':
      await pool.restart(id)
      return json({ ok: true })
    default:
      return json({ error: `unknown action ${action}` }, 404)
  }
}

const verbose = process.env.PEERS_E2E_VERBOSE === '1'

async function route(req: Request): Promise<Response> {
  if (verbose)
    process.stderr.write(`fixture ${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname}\n`)
  const parts = new URL(req.url).pathname.split('/').filter((p) => p !== '')
  if (req.method === 'GET' && parts[0] === 'health') return json({ ok: true })
  if (parts[0] !== 'hubs') return json({ error: 'not found' }, 404)
  const [, id, action] = parts
  if (req.method === 'POST' && id === undefined) {
    const body = await readJson<CreateHubRequest>(req)
    return json(await pool.create(body.size ?? 'small'))
  }
  if (id === undefined) return json({ error: 'not found' }, 404)
  if (req.method === 'DELETE' && action === undefined) {
    await pool.remove(id)
    return json({ ok: true })
  }
  if (req.method === 'POST' && action !== undefined) return hubAction(id, action, req)
  return json({ error: 'not found' }, 404)
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 120,
  fetch: async (req) => {
    try {
      return await route(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`fixture: ${req.method} ${req.url}: ${message}\n`)
      return json({ error: message }, 500)
    }
  },
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await server.stop(true)
  await pool.removeAll()
  await built.cleanup()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

process.stdout.write(`${JSON.stringify({ control: `http://127.0.0.1:${server.port}` })}\n`)
