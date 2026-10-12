/**
 * The member API (PROTOCOL §9) called from the signed-in browser context, so it uses the same session
 * cookie as the page. Responses are parsed with the protocol schemas: the e2e checks the hub state
 * the UI claims, not just the UI.
 */
import {
  type AskFilter,
  AsksResponseSchema,
  PatchSessionResponseSchema,
  RoomDetailResponseSchema,
  SessionsResponseSchema,
} from '../../../packages/protocol/src/member-api'
import type { Page } from './deps'

type Sessions = ReturnType<typeof SessionsResponseSchema.parse>['sessions']
type RoomDetail = ReturnType<typeof RoomDetailResponseSchema.parse>
type Asks = ReturnType<typeof AsksResponseSchema.parse>

export interface MemberApi {
  sessions(): Promise<Sessions>
  session(sessionId: string): Promise<Sessions[number]>
  room(roomId: string): Promise<RoomDetail>
  /** Status of `GET /v0/me/rooms/:id` (404 once dissolved, 403 once kicked). */
  roomStatus(roomId: string): Promise<number>
  asks(filter: AskFilter): Promise<Asks>
  /** Changes a session outside the page (another tab, or the CLI): the page must follow via SSE. */
  setAccepting(sessionId: string, accepting: boolean): Promise<void>
}

export function memberApi(page: Page, origin: string): MemberApi {
  const get = async (path: string): Promise<unknown> => {
    const res = await page.request.get(`${origin}${path}`)
    if (!res.ok()) throw new Error(`GET ${path}: ${res.status()} ${await res.text()}`)
    return res.json()
  }
  const sessions = async () => SessionsResponseSchema.parse(await get('/v0/me/sessions')).sessions
  return {
    sessions,
    session: async (sessionId) => {
      const found = (await sessions()).find((s) => s.session_id === sessionId)
      if (found === undefined) throw new Error(`no session ${sessionId}`)
      return found
    },
    room: async (roomId) => RoomDetailResponseSchema.parse(await get(`/v0/me/rooms/${roomId}`)),
    roomStatus: async (roomId) => (await page.request.get(`${origin}/v0/me/rooms/${roomId}`)).status(),
    asks: async (filter) => AsksResponseSchema.parse(await get(`/v0/me/asks?filter=${filter}`)),
    setAccepting: async (sessionId, accepting) => {
      const res = await page.request.patch(`${origin}/v0/me/sessions/${sessionId}`, {
        headers: { origin },
        data: { accepting },
      })
      if (!res.ok()) throw new Error(`PATCH session: ${res.status()} ${await res.text()}`)
      PatchSessionResponseSchema.parse(await res.json())
    },
  }
}
