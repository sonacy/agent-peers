/**
 * Typed member-API client (PROTOCOL §9, DASHBOARD §11). Every response is validated with the
 * protocol schema; failures become `ApiError`. Cookies ride along (`credentials: 'include'`) and the
 * browser adds `Origin` to mutations, which the hub checks.
 */
import {
  AsksResponseSchema,
  CreateRoomResponseSchema,
  ErrorBodySchema,
  InviteActionResponseSchema,
  KnockResponseSchema,
  MEMBER_API_PREFIX,
  MeResponseSchema,
  MyRoomsResponseSchema,
  OkResponseSchema,
  PatchSessionResponseSchema,
  ROOM_SEARCH_PATH,
  RoomDetailResponseSchema,
  RoomSearchResponseSchema,
  SessionsResponseSchema,
} from '@agent-peers/protocol'
import { ApiError, codeForStatus, toErrorCode } from './errors'
import type {
  AskFilter,
  AsksPage,
  CreatedRoom,
  CreateRoomInput,
  InviteAction,
  InviteActionResult,
  Knock,
  KnockResult,
  Me,
  MyRoom,
  Parsed,
  ParseSchema,
  RoomDetail,
  SearchRoom,
  SessionCard,
  SessionPatch,
} from './types'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ApiClientOptions {
  /** Defaults to the global fetch. */
  readonly fetch?: FetchLike
  /** Origin prefix for requests; empty for same-origin (the default). */
  readonly baseUrl?: string
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

const LoginResponseSchema = OkResponseSchema.extend({ member: MeResponseSchema.optional() })

/** `GET /v0/me/knocks`: `{ knocks }`, the same knock shape the room detail carries. */
const MyKnocksResponseSchema = RoomDetailResponseSchema.pick({ knocks: true }).required()

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

export function createApiClient(options: ApiClientOptions = {}) {
  const base = options.baseUrl ?? ''
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

  async function send(method: Method, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    try {
      return await doFetch(`${base}${path}`, {
        method,
        credentials: 'include',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network error'
      throw new ApiError('disconnected', message, 0)
    }
  }

  async function request<S extends ParseSchema>(
    schema: S,
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<Parsed<S>> {
    const response = await send(method, path, body)
    if (!response.ok) throw await failure(response)
    const json = await readJson(response)
    try {
      return schema.parse(json) as Parsed<S>
    } catch {
      throw new ApiError('invalid_result', `unexpected response from ${path}`, response.status)
    }
  }

  const me = MEMBER_API_PREFIX
  const ok = async (method: Method, path: string, body?: unknown): Promise<void> => {
    await request(OkResponseSchema, method, path, body)
  }

  return {
    me: (): Promise<Me> => request(MeResponseSchema, 'GET', me),
    sessions: async (): Promise<readonly SessionCard[]> =>
      (await request(SessionsResponseSchema, 'GET', `${me}/sessions`)).sessions,
    rooms: async (): Promise<readonly MyRoom[]> =>
      (await request(MyRoomsResponseSchema, 'GET', `${me}/rooms`)).rooms,
    room: (roomId: string): Promise<RoomDetail> =>
      request(RoomDetailResponseSchema, 'GET', `${me}/rooms/${enc(roomId)}`),
    searchRooms: async (q: string): Promise<readonly SearchRoom[]> =>
      (await request(RoomSearchResponseSchema, 'GET', `${ROOM_SEARCH_PATH}?q=${enc(q)}`)).rooms,
    /** My own pending knocks (withdrawing one needs its id). */
    myKnocks: async (): Promise<readonly Knock[]> =>
      (await request(MyKnocksResponseSchema, 'GET', `${me}/knocks`)).knocks,
    asks: (filter: AskFilter, cursor?: string): Promise<AsksPage> => {
      const query = cursor === undefined ? '' : `&cursor=${enc(cursor)}`
      return request(AsksResponseSchema, 'GET', `${me}/asks?filter=${filter}${query}`)
    },

    login: async (code: string): Promise<void> => {
      await request(LoginResponseSchema, 'POST', '/app/login', { code })
    },
    logout: (): Promise<void> => ok('POST', `${me}/logout`),

    patchSession: async (sessionId: string, patch: SessionPatch): Promise<SessionCard> =>
      (await request(PatchSessionResponseSchema, 'PATCH', `${me}/sessions/${enc(sessionId)}`, patch)).session,
    createRoom: (input: CreateRoomInput): Promise<CreatedRoom> =>
      request(CreateRoomResponseSchema, 'POST', `${me}/rooms`, input),
    knock: (roomId: string, note?: string): Promise<KnockResult> =>
      request(KnockResponseSchema, 'POST', `${me}/rooms/${enc(roomId)}/knock`, note ? { note } : {}),
    withdrawKnock: (knockId: string): Promise<void> => ok('DELETE', `${me}/knocks/${enc(knockId)}`),
    decideKnock: (knockId: string, decision: 'accept' | 'decline'): Promise<KnockResult> =>
      request(KnockResponseSchema, 'POST', `${me}/knocks/${enc(knockId)}/decide`, { decision }),
    inviteAction: (roomId: string, action: InviteAction): Promise<InviteActionResult> =>
      request(InviteActionResponseSchema, 'POST', `${me}/rooms/${enc(roomId)}/invite/${action}`),
    restoreMember: (roomId: string, member: string): Promise<void> =>
      ok('POST', `${me}/rooms/${enc(roomId)}/restore/${enc(member)}`),
    exitRoom: (roomId: string): Promise<void> => ok('POST', `${me}/rooms/${enc(roomId)}/exit`),
    removeSession: (roomId: string, sessionId: string): Promise<void> =>
      ok('DELETE', `${me}/rooms/${enc(roomId)}/sessions/${enc(sessionId)}`),
    kickMember: (roomId: string, member: string): Promise<void> =>
      ok('DELETE', `${me}/rooms/${enc(roomId)}/grants/${enc(member)}`),
    dissolveRoom: (roomId: string): Promise<void> => ok('DELETE', `${me}/rooms/${enc(roomId)}`),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
