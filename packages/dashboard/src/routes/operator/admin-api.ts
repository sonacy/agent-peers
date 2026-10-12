/**
 * Typed client for the admin listener (PROTOCOL §9, DASHBOARD §10). Same rules as the member client:
 * same-origin cookies, the browser's Origin on mutations, every response validated, every failure an
 * `ApiError`. The admin token is only ever sent in the login body, never in a URL.
 */
import { ErrorBodySchema } from '@agent-peers/protocol'
import type { FetchLike } from '../../api/client'
import { ApiError, codeForStatus, toErrorCode } from '../../api/errors'
import type { Parsed, ParseSchema } from '../../api/types'
import {
  type AdminMember,
  AdminMembersSchema,
  type AdminRoom,
  AdminRoomsSchema,
  type HubSettings,
  HubSettingsSchema,
  type HubStatus,
  HubStatusSchema,
  OkSchema,
  RevokeResultSchema,
  type RotateResult,
  RotateResultSchema,
  type SettingsPatch,
  WhoamiSchema,
} from './admin-schemas'

export const ADMIN_API = '/v0/admin'

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface AdminClientOptions {
  readonly fetch?: FetchLike
  readonly baseUrl?: string
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function failure(response: Response): Promise<ApiError> {
  const parsed = ErrorBodySchema.safeParse(await readJson(response))
  if (!parsed.success) {
    return new ApiError(
      codeForStatus(response.status),
      response.statusText || 'request failed',
      response.status,
    )
  }
  const { code, message, retry_after_ms } = parsed.data.error
  return new ApiError(toErrorCode(code, response.status), message, response.status, retry_after_ms)
}

const enc = encodeURIComponent

export function createAdminClient(options: AdminClientOptions = {}) {
  const base = options.baseUrl ?? ''
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

  async function request<S extends ParseSchema>(
    schema: S,
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<Parsed<S>> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await doFetch(`${base}${ADMIN_API}${path}`, {
        method,
        credentials: 'include',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw new ApiError('disconnected', error instanceof Error ? error.message : 'network error', 0)
    }
    if (!response.ok) throw await failure(response)
    const json = await readJson(response)
    try {
      return schema.parse(json) as Parsed<S>
    } catch {
      throw new ApiError('invalid_result', `unexpected response from ${path}`, response.status)
    }
  }

  return {
    whoami: async (): Promise<boolean> => (await request(WhoamiSchema, 'GET', '/whoami')).admin,
    login: async (token: string): Promise<void> => {
      await request(OkSchema, 'POST', '/login', { token })
    },
    logout: async (): Promise<void> => {
      await request(OkSchema, 'POST', '/logout')
    },
    status: (): Promise<HubStatus> => request(HubStatusSchema, 'GET', '/status'),
    settings: (): Promise<HubSettings> => request(HubSettingsSchema, 'GET', '/settings'),
    patchSettings: (patch: SettingsPatch): Promise<HubSettings> =>
      request(HubSettingsSchema, 'PATCH', '/settings', patch),
    rooms: async (): Promise<readonly AdminRoom[]> =>
      (await request(AdminRoomsSchema, 'GET', '/rooms')).rooms,
    members: async (): Promise<readonly AdminMember[]> =>
      (await request(AdminMembersSchema, 'GET', '/members')).members,
    dissolveRoom: async (roomId: string): Promise<void> => {
      await request(OkSchema, 'DELETE', `/rooms/${enc(roomId)}`)
    },
    revokeTokens: async (memberId: string): Promise<number> =>
      (await request(RevokeResultSchema, 'DELETE', `/members/${enc(memberId)}/tokens`)).revoked,
    rotateToken: (): Promise<RotateResult> => request(RotateResultSchema, 'POST', '/rotate-admin-token'),
  }
}

export type AdminClient = ReturnType<typeof createAdminClient>
