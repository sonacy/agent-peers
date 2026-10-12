/** The test side of the fixture server's control API (see `fixture/contract.ts`). */
import {
  CONTROL_ENV,
  type CreateHubRequest,
  type ErrorResponse,
  type HubInfo,
  type LoginResponse,
} from '../fixture/contract'

function controlUrl(): string {
  const url = process.env[CONTROL_ENV]
  if (url === undefined || url === '')
    throw new Error(`${CONTROL_ENV} is not set: run through playwright.config.ts`)
  return url
}

async function call<T>(method: 'POST' | 'DELETE', path: string, body?: object): Promise<T> {
  const res = await fetch(`${controlUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json()) as T | ErrorResponse
  if (!res.ok) throw new Error(`fixture ${method} ${path}: ${(data as ErrorResponse).error}`)
  return data as T
}

export interface HubControl {
  readonly info: HubInfo
  /** A fresh one-time sign-in link for a demo member. */
  loginUrl(member: string): Promise<string>
  /** The agent renames itself through its bridge session (not through the dashboard). */
  renameAgent(agent: string, title: string): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  dispose(): Promise<void>
}

export async function createHubControl(request: CreateHubRequest = {}): Promise<HubControl> {
  const info = await call<HubInfo>('POST', '/hubs', request)
  const base = `/hubs/${info.id}`
  return {
    info,
    loginUrl: async (member) => (await call<LoginResponse>('POST', `${base}/login`, { member })).url,
    renameAgent: async (agent, title) => {
      await call('POST', `${base}/title`, { agent, title })
    },
    stop: async () => {
      await call('POST', `${base}/stop`)
    },
    restart: async () => {
      await call('POST', `${base}/restart`)
    },
    dispose: async () => {
      await call('DELETE', base)
    },
  }
}
