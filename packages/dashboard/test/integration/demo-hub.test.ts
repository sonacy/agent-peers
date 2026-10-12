/**
 * Integration: the seeded demo hub (scripts/demo) against the real member and admin APIs, and the
 * operator view's admin client as a contract test against a real admin listener.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { silentLogger } from '@agent-peers/hub'
import {
  AsksResponseSchema,
  MyRoomsResponseSchema,
  RoomDetailResponseSchema,
  RoomSearchResponseSchema,
  SessionsResponseSchema,
} from '@agent-peers/protocol'
import { type DemoHub, startDemoHub } from '../../scripts/demo/hub'
import { type AdminClient, createAdminClient } from '../../src/routes/operator/admin-api'

const SMALL = { bigRoomMembers: 6, bigRoomOnline: 2, bigRoomBusy: 3, bigRoomKnocks: 4 }

let demo: DemoHub

/** A browser-ish fetch for one origin: same-origin Origin header and a one-cookie jar. */
function browser(origin: string) {
  let cookie: string | undefined
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('origin', origin)
    if (cookie !== undefined) headers.set('cookie', cookie)
    const res = await fetch(input.startsWith('http') ? input : `${origin}${input}`, { ...init, headers })
    const set = res.headers.get('set-cookie')
    if (set !== null) cookie = set.split(';')[0]
    return res
  }
}

async function signedInMember(link?: Promise<{ readonly url: string }>) {
  const get = browser(demo.url)
  const url = link === undefined ? await demo.seeded.loginUrl() : (await link).url
  const code = new URL(url).searchParams.get('c')
  const login = await get('/app/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(login.status).toBe(200)
  return async <T>(path: string, schema: { parse(v: unknown): T }): Promise<T> =>
    schema.parse(await (await get(path)).json())
}

beforeAll(async () => {
  demo = await startDemoHub({
    ...SMALL,
    logger: silentLogger,
    source: { assets: new Map([['index.html', '<!doctype html><div id="root"></div>']]) },
  })
}, 60_000)

afterAll(async () => {
  await demo?.stop()
})

describe('demo hub seed', () => {
  it('gives gulei the four mockup agents in idle, busy and offline', async () => {
    const read = await signedInMember()
    const { sessions } = await read('/v0/me/sessions', SessionsResponseSchema)
    const byTitle = new Map(sessions.map((s) => [s.title, s]))
    expect([...byTitle.keys()].sort()).toEqual(
      [
        'Recent popular agent projects',
        'prd2demo',
        '调研 T3Code 项目',
        '通用插件将 agent session 同步',
      ].sort(),
    )
    expect(byTitle.get('通用插件将 agent session 同步')?.activity).toBe('busy')
    expect(byTitle.get('调研 T3Code 项目')?.agent.kind).toBe('codex')
    expect(byTitle.get('Recent popular agent projects')?.inject).toBe('poll')
    expect(byTitle.get('prd2demo')?.connection).toBe('offline')
    expect(byTitle.get('prd2demo')?.rooms.length).toBe(2)
  })

  it('seats gulei in owned and joined rooms with knocks, a closed invite and a removed person', async () => {
    const read = await signedInMember()
    const { rooms } = await read('/v0/me/rooms', MyRoomsResponseSchema)
    const byName = new Map(rooms.map((r) => [r.room.name, r]))
    expect(byName.get('timely')).toMatchObject({ role: 'owner', people: 3, pending_knocks: 2 })
    expect(byName.get('pay-integration')).toMatchObject({ role: 'member' })
    expect(byName.get('pay-integration')?.room.display_name).toBe('支付联调')
    expect(byName.get('onboarding-2026')).toMatchObject({
      role: 'owner',
      people: SMALL.bigRoomMembers + 1,
      agents: SMALL.bigRoomMembers * 2 + 1,
      pending_knocks: SMALL.bigRoomKnocks,
    })
    const timely = await read(`/v0/me/rooms/${demo.seeded.rooms.timely}`, RoomDetailResponseSchema)
    expect(timely.knocks?.map((k) => k.note).every((note) => (note ?? '').length > 0)).toBe(true)
    const llm = await read(`/v0/me/rooms/${demo.seeded.rooms.llmEval}`, RoomDetailResponseSchema)
    expect(llm.invite?.state ?? 'closed').toBe('closed')
    expect(llm.kicked?.map((k) => k.member)).toEqual(['zhou-min'])
  })

  it('offers discoverable rooms to knock on, one already knocked, and repeats its ids', async () => {
    const read = await signedInMember()
    const { rooms } = await read('/v0/rooms/search?q=api', RoomSearchResponseSchema)
    const state = new Map(rooms.map((r) => [r.name, r.my_state]))
    expect(state.get('api-review')).toBe('none')
    expect(state.get('api-docs')).toBe('knocking')
    expect(demo.seeded.rooms.apiReview).toMatch(/^01KDVD/)
  })

  it('seats he-yu in more than 12 rooms and leaves xiao-bai with none', async () => {
    const roomsOf = async (member: string) => {
      const agent = demo.seeded.agents.find((a) => a.member === member)
      if (agent === undefined) throw new Error(`no agent for ${member}`)
      const read = await signedInMember(agent.handle.dashboardLogin())
      return (await read('/v0/me/rooms', MyRoomsResponseSchema)).rooms
    }
    const crowd = await roomsOf('he-yu')
    expect(crowd).toHaveLength(13)
    expect(crowd.filter((r) => r.role === 'owner')).toHaveLength(8)
    expect(crowd.some((r) => (r.pending_knocks ?? 0) > 0)).toBe(true)
    expect(await roomsOf('xiao-bai')).toEqual([])
  })

  it('has Q&A in every state, with a long answer carrying code and a link', async () => {
    const read = await signedInMember()
    const { asks } = await read('/v0/me/asks?filter=all', AsksResponseSchema)
    const states = new Set(asks.map((a) => a.ask.state))
    for (const state of ['answered', 'declined', 'failed', 'expired', 'queued', 'delivered', 'working']) {
      expect(states.has(state as never)).toBe(true)
    }
    expect(asks.find((a) => a.ask.state === 'failed')?.ask.reason).toBe('not_in_room')
    const long = asks.find((a) => (a.answer?.text ?? '').includes('```ts'))
    expect(long?.answer?.text).toContain('https://')
    expect((long?.answer?.text ?? '').split('\n').length).toBeGreaterThan(8)
  })
})

describe('admin client against the demo hub', () => {
  let admin: AdminClient

  beforeAll(async () => {
    admin = createAdminClient({ fetch: browser(demo.adminUrl), baseUrl: demo.adminUrl })
  })

  it('refuses without a cookie, then signs in with the admin token', async () => {
    expect(await admin.whoami().catch((e: { code: string }) => e.code)).toBe('unauthorized')
    expect(await admin.login('apa_wrong').catch((e: { code: string }) => e.code)).toBe('unauthorized')
    await admin.login(demo.info.adminToken)
    expect(await admin.whoami()).toBe(true)
  })

  it('reads status, settings, rooms and members', async () => {
    const status = await admin.status()
    // timely, 支付联调, llm-eval, onboarding, 3 discoverable rooms, he-yu's 8 and lin-feng's 5.
    expect(status.rooms).toBe(20)
    expect(status.sessions_online).toBeGreaterThan(0)
    const settings = await admin.settings()
    expect(settings.registration).toBe('invite-only')
    const rooms = await admin.rooms()
    const names = rooms.map((r) => r.room.name)
    expect(names).toHaveLength(20)
    for (const name of ['llm-eval', 'onboarding-2026', 'pay-integration', 'timely', 'api-review', 'sdk-v3']) {
      expect(names).toContain(name)
    }
    const members = await admin.members()
    expect(members.map((m) => m.name)).toContain('gulei')
  })

  it('changes settings, revokes tokens, dissolves a room and rotates its own token', async () => {
    expect((await admin.patchSettings({ registration: 'open' })).registration).toBe('open')
    await admin.patchSettings({ registration: 'invite-only' })
    const member = (await admin.members()).find((m) => m.name === 'zhao-lei')
    if (member === undefined) throw new Error('no big-room member')
    expect(await admin.revokeTokens(member.member_id)).toBe(1)
    await admin.dissolveRoom(demo.seeded.rooms.onboarding)
    expect((await admin.rooms()).map((r) => r.room.name)).not.toContain('onboarding-2026')
    const rotated = await admin.rotateToken()
    expect(rotated.persisted).toBe(false)
    expect(rotated.admin_token).not.toBe(demo.info.adminToken)
    expect(await admin.whoami()).toBe(true)
    await admin.logout()
    expect(await admin.whoami().catch((e: { code: string }) => e.code)).toBe('unauthorized')
  })
})
