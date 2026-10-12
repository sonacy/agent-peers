/**
 * The admin API client used on the hub host (PROTOCOL §9): `Authorization: Bearer <admin token>`
 * from `<data-dir>/admin-token`, against the admin listener recorded in `<data-dir>/hub.json`
 * (default 127.0.0.1:7338). Never follows redirects; errors map to PeersError codes.
 */
import { DEFAULT_ADMIN_BIND, DEFAULT_ADMIN_PORT, ErrorBodySchema, PeersError } from '@agent-peers/protocol'
import { dialHost, hostForUrl } from './hub-output'
import { adminTokenPath, readAdminToken, readHubState } from './hub-state'

export const ADMIN_TIMEOUT_MS = 10_000

export interface AdminTarget {
  /** e.g. `http://127.0.0.1:7338` */
  readonly baseUrl: string
  readonly token: string
}

export interface AdminClient {
  readonly baseUrl: string
  request(method: string, path: string, body?: unknown): Promise<unknown>
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface AdminClientDeps {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
}

/** `--admin-url`, else the running hub's recorded listener, else the default admin address. */
export async function adminBaseUrl(dataDir: string, override?: string): Promise<string> {
  if (override !== undefined) {
    let url: URL
    try {
      url = new URL(override)
    } catch {
      throw new PeersError('invalid_params', `--admin-url ${override} is not a URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new PeersError('invalid_params', '--admin-url must be an http(s) URL')
    return url.origin
  }
  const state = await readHubState(dataDir)
  const bind = state?.admin_bind ?? DEFAULT_ADMIN_BIND
  const port = state?.admin_port ?? DEFAULT_ADMIN_PORT
  return `http://${hostForUrl(dialHost(bind))}:${port}`
}

export async function resolveAdminTarget(dataDir: string, override?: string): Promise<AdminTarget> {
  const token = await readAdminToken(dataDir)
  if (token === undefined) {
    throw new PeersError(
      'unauthorized',
      `no admin token at ${adminTokenPath(dataDir)}: run "agent-peers hub" on this machine first (or pass --data-dir)`,
    )
  }
  return { baseUrl: await adminBaseUrl(dataDir, override), token }
}

async function errorFrom(response: Response): Promise<PeersError> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const body = ErrorBodySchema.safeParse(parsed)
  if (body.success) return new PeersError(body.data.error.code as PeersError['code'], body.data.error.message)
  return new PeersError('internal', `admin API answered HTTP ${response.status}`)
}

export function createAdminClient(target: AdminTarget, deps: AdminClientDeps = {}): AdminClient {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = deps.timeoutMs ?? ADMIN_TIMEOUT_MS
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response
    try {
      response = await doFetch(`${target.baseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new PeersError(
        'not_connected',
        `the hub's admin listener at ${target.baseUrl} is not reachable (is "agent-peers hub" running?)`,
        undefined,
        { cause: error },
      )
    }
    if (!response.ok) throw await errorFrom(response)
    return response.json()
  }
  return { baseUrl: target.baseUrl, request }
}

// ---- response parsing ----------------------------------------------------------------------------

export type Json = Readonly<Record<string, unknown>>

export const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(what: string): PeersError {
  return new PeersError('invalid_result', `unexpected admin API response (${what})`)
}

export function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw invalid(key)
  return value[key]
}

export function stringField(value: unknown, key: string): string {
  const found = field(value, key)
  if (typeof found !== 'string') throw invalid(key)
  return found
}

export function numberField(value: unknown, key: string, fallback = 0): number {
  const found = field(value, key)
  return typeof found === 'number' ? found : fallback
}

export function arrayField(value: unknown, key: string): readonly unknown[] {
  const found = field(value, key)
  if (!Array.isArray(found)) throw invalid(key)
  return found
}
