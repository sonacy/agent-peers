import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import type { QueryClient } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createApiClient } from '../../src/api/client'
import { queryKeys } from '../../src/api/keys'
import { usePatchSession, useRemoveFromRoom } from '../../src/api/mutations'
import { useRoom, useRoomSearch } from '../../src/api/queries'
import type { Knock, MyRoom, RoomDetail, SearchRoom, SessionCard } from '../../src/api/types'
import { useKnock, useWithdrawKnock } from '../../src/components/rooms/data/use-knocks'
import {
  BULK_CONCURRENCY,
  useDecideKnocks,
  useInviteAction,
  useKickPerson,
  useRemoveAllAgents,
} from '../../src/components/rooms/data/use-room-actions'
import { useCreateRoom, useExitRoom } from '../../src/components/rooms/data/use-room-lifecycle'
import { createQueryClient, Providers } from '../../src/providers'
import { PATHS } from '../../src/routes/paths'
import { apiError, createFakeHub, type FakeHub, type Handler, json } from '../helpers/fake-hub'
import { card, ME, myRoom } from '../helpers/fixtures'
import { screen, setupUi, waitFor } from '../helpers/render'
import { invite, knock, ownerDetail, ROOM_ID, searchRoom } from '../helpers/room-fixtures'

setupUi()

const OK = { ok: true }
const ROOM = `/v0/me/rooms/${ROOM_ID}`

function setup(routes: Record<string, Handler> = {}) {
  const hub = createFakeHub({
    'GET /v0/me/rooms/r_1': { room: { room_id: 'r_1', name: 'timely' }, my_role: 'member', people: [] },
    'GET /v0/me/rooms/r_gone': () => apiError('room_not_found', 404),
    'GET /v0/rooms/search': { rooms: [] },
    ...routes,
  })
  const client = createQueryClient()
  const api = createApiClient({ fetch: hub.fetch })
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <Providers client={client} api={api}>
      {children}
    </Providers>
  )
  return { hub, client, wrapper }
}

const invalidated = (client: QueryClient, key: readonly unknown[]): boolean =>
  client.getQueryState(key)?.isInvalidated === true

const knocksIn = (client: QueryClient): readonly string[] =>
  (client.getQueryData<RoomDetail>(queryKeys.room(ROOM_ID))?.knocks ?? []).map((k) => k.knock_id)

/** Knock decisions answered after a short delay, recording how many were in flight at once. */
function decideRoutes(ids: readonly string[], failing: ReadonlySet<string>) {
  const peak = { now: 0, max: 0 }
  const routes: Record<string, Handler> = {}
  for (const id of ids) {
    routes[`POST /v0/me/knocks/${id}/decide`] = async () => {
      peak.now += 1
      peak.max = Math.max(peak.max, peak.now)
      await Bun.sleep(5)
      peak.now -= 1
      return failing.has(id)
        ? apiError('rate_limited', 429, 'too many requests')
        : { knock: knock(id, id, { state: 'accepted' }) }
    }
  }
  return { routes, peak }
}

describe('room queries', () => {
  it('loads a room and does not retry a missing one', async () => {
    const { hub, wrapper } = setup()
    const room = renderHook(() => useRoom('r_1'), { wrapper })
    await waitFor(() => expect(room.result.current.data?.my_role).toBe('member'))
    const gone = renderHook(() => useRoom('r_gone'), { wrapper })
    await waitFor(() => expect(gone.result.current.isError).toBe(true))
    expect(hub.callsTo('GET /v0/me/rooms/r_gone')).toHaveLength(1)
    const search = renderHook(() => useRoomSearch('api'), { wrapper })
    await waitFor(() => expect(search.result.current.data).toEqual([]))
  })
})

describe('knocking (use-knocks)', () => {
  it('flips the search row to 等开门 at once, stores the knock id and refetches', async () => {
    const pending = knock('k_9', 'gulei', { room_id: 'r_pay' })
    const { client, wrapper } = setup({
      'POST /v0/me/rooms/r_pay/knock': () => json({ knock: pending }, 201),
    })
    client.setQueryData<readonly SearchRoom[]>(queryKeys.roomSearch('pay'), [searchRoom('r_pay', 'pay')])
    client.setQueryData<readonly Knock[]>(queryKeys.myKnocks, [])
    const { result } = renderHook(() => useKnock(), { wrapper })
    await act(() => result.current.mutateAsync({ roomId: 'r_pay', roomName: 'pay', note: '你好' }))
    expect(client.getQueryData<readonly SearchRoom[]>(queryKeys.roomSearch('pay'))?.[0]?.my_state).toBe(
      'knocking',
    )
    expect(client.getQueryData<readonly Knock[]>(queryKeys.myKnocks)?.map((k) => k.knock_id)).toEqual(['k_9'])
    expect(invalidated(client, queryKeys.myKnocks)).toBe(true)
    expect(invalidated(client, queryKeys.roomSearch('pay'))).toBe(true)
  })
  it('rolls the row back with a toast when the hub refuses', async () => {
    const { client, wrapper } = setup({
      'POST /v0/me/rooms/r_pay/knock': () => apiError('forbidden', 403, 'no'),
    })
    client.setQueryData<readonly SearchRoom[]>(queryKeys.roomSearch('pay'), [searchRoom('r_pay', 'pay')])
    const { result } = renderHook(() => useKnock(), { wrapper })
    await act(() => result.current.mutateAsync({ roomId: 'r_pay', roomName: 'pay' }).catch(() => undefined))
    expect(client.getQueryData<readonly SearchRoom[]>(queryKeys.roomSearch('pay'))?.[0]?.my_state).toBe(
      'none',
    )
    expect(await screen().findByText('门没敲成')).toBeDefined()
  })
  it('withdraws by id and drops the knock from my list at once', async () => {
    const { hub, client, wrapper } = setup({ 'DELETE /v0/me/knocks/k_9': OK })
    client.setQueryData<readonly Knock[]>(queryKeys.myKnocks, [knock('k_9', 'gulei', { room_id: 'r_pay' })])
    const { result } = renderHook(() => useWithdrawKnock(), { wrapper })
    await act(() => result.current.mutateAsync({ roomId: 'r_pay', roomName: 'pay', knockId: 'k_9' }))
    expect(hub.callsTo('DELETE /v0/me/knocks/k_9')).toHaveLength(1)
    expect(client.getQueryData<readonly Knock[]>(queryKeys.myKnocks)).toEqual([])
  })
})

describe('deciding knocks (use-room-actions)', () => {
  const ids = ['k_1', 'k_2', 'k_3', 'k_4', 'k_5', 'k_6'] as const
  const knocks = ids.map((id) => knock(id, id))

  function seeded(routes: Record<string, Handler>) {
    const env = setup(routes)
    env.client.setQueryData(queryKeys.room(ROOM_ID), ownerDetail({ knocks }))
    env.client.setQueryData<readonly MyRoom[]>(queryKeys.rooms, [myRoom({ id: ROOM_ID, pending_knocks: 6 })])
    return env
  }

  it('lets everyone in a few at a time', async () => {
    const { routes, peak } = decideRoutes(ids, new Set())
    const { client, wrapper } = seeded(routes)
    const { result } = renderHook(() => useDecideKnocks(ROOM_ID), { wrapper })
    await act(() => result.current.mutateAsync({ knocks, decision: 'accept' }))
    expect(peak.max).toBeLessThanOrEqual(BULK_CONCURRENCY)
    expect(knocksIn(client)).toEqual([])
    expect(await screen().findByText('已开门，6 个人进来了')).toBeDefined()
    expect(invalidated(client, queryKeys.room(ROOM_ID))).toBe(true)
    expect(invalidated(client, queryKeys.rooms)).toBe(true)
  })
  it('keeps the knocks that went through when one fails, and says how many did not', async () => {
    const { routes } = decideRoutes(ids, new Set(['k_3']))
    const { client, wrapper } = seeded(routes)
    const { result } = renderHook(() => useDecideKnocks(ROOM_ID), { wrapper })
    await act(() => result.current.mutateAsync({ knocks, decision: 'accept' }))
    expect(knocksIn(client)).toEqual(['k_3'])
    expect(client.getQueryData<readonly MyRoom[]>(queryKeys.rooms)?.[0]?.pending_knocks).toBe(1)
    expect(await screen().findByText('已开门 5 个，1 个没成功')).toBeDefined()
    expect(screen().queryByText('门没开成')).toBeNull()
  })
  it('rolls everything back when nothing went through', async () => {
    const { routes } = decideRoutes(ids, new Set(ids))
    const { client, wrapper } = seeded(routes)
    const { result } = renderHook(() => useDecideKnocks(ROOM_ID), { wrapper })
    await act(() => result.current.mutateAsync({ knocks, decision: 'decline' }).catch(() => undefined))
    expect(knocksIn(client)).toEqual([...ids])
    expect(await screen().findByText('门没开成')).toBeDefined()
  })
})

describe('people and invite actions (use-room-actions)', () => {
  it('removes all of a person’s agents, keeping the ones that went if one fails', async () => {
    const detail = ownerDetail()
    const { client, wrapper } = setup({
      [`DELETE ${ROOM}/sessions/s_sync`]: OK,
      [`DELETE ${ROOM}/sessions/s_t3`]: () => apiError('forbidden', 403, 'no'),
      [`DELETE ${ROOM}/sessions/s_prd`]: OK,
    })
    client.setQueryData(queryKeys.room(ROOM_ID), detail)
    const { result } = renderHook(() => useRemoveAllAgents(ROOM_ID), { wrapper })
    await act(() =>
      result.current.mutateAsync({
        memberId: 'm_gulei',
        name: 'gulei',
        sessionIds: ['s_sync', 's_t3', 's_prd'],
      }),
    )
    const mine = client.getQueryData<RoomDetail>(queryKeys.room(ROOM_ID))?.people[0]
    expect(mine?.agents.map((a) => a.card.session_id)).toEqual(['s_t3'])
    expect(await screen().findByText('移出了 2 个，1 个没移出去')).toBeDefined()
    expect(invalidated(client, queryKeys.sessions)).toBe(false)
  })
  it('kicks at once into 被请出的人 and refetches the room and my list', async () => {
    const { client, wrapper } = setup({ [`DELETE ${ROOM}/grants/m_lina`]: OK })
    client.setQueryData(queryKeys.room(ROOM_ID), ownerDetail())
    client.setQueryData<readonly MyRoom[]>(queryKeys.rooms, [])
    const { result } = renderHook(() => useKickPerson(ROOM_ID), { wrapper })
    await act(() => result.current.mutateAsync({ memberId: 'm_lina', name: 'lina' }))
    const detail = client.getQueryData<RoomDetail>(queryKeys.room(ROOM_ID))
    expect(detail?.kicked?.map((k) => k.member)).toEqual(['lina'])
    expect(detail?.people.some((p) => p.member === 'lina')).toBe(false)
    expect(invalidated(client, queryKeys.room(ROOM_ID))).toBe(true)
    expect(invalidated(client, queryKeys.rooms)).toBe(true)
  })
  it('stores the rotated invite from the hub’s answer', async () => {
    const fresh = invite({ code_masked: 'inv_••••NEW1' })
    const { client, wrapper } = setup({
      [`POST ${ROOM}/invite/rotate`]: { invite: fresh, join_prompt: 'new prompt' },
    })
    client.setQueryData(queryKeys.room(ROOM_ID), ownerDetail())
    const { result } = renderHook(() => useInviteAction(ROOM_ID, 'rotate'), { wrapper })
    await act(() => result.current.mutateAsync())
    const detail = client.getQueryData<RoomDetail>(queryKeys.room(ROOM_ID))
    expect(detail?.invite?.code_masked).toBe('inv_••••NEW1')
    expect(detail?.join_prompt).toBe('new prompt')
  })
})

describe('room lifecycle (use-room-lifecycle)', () => {
  it('creates a room and seeds its detail with me as the owner', async () => {
    const { client, wrapper } = setup({
      'POST /v0/me/rooms': () =>
        json(
          {
            room: { room_id: 'r_new', name: 'new' },
            invite: invite({ room_id: 'r_new' }),
            invite_url: 'u',
            join_prompt: 'p',
          },
          201,
        ),
    })
    client.setQueryData(queryKeys.me, ME)
    const { result } = renderHook(() => useCreateRoom(), { wrapper })
    const created = await act(() => result.current.mutateAsync({ name: 'new' }))
    expect(created.room.room_id).toBe('r_new')
    const seed = client.getQueryData<RoomDetail>(queryKeys.room('r_new'))
    expect(seed?.people.map((p) => p.member)).toEqual(['gulei'])
    expect(seed?.join_prompt).toBe('p')
  })
  it('leaves a room: drops it from my list at once and forgets its detail', async () => {
    let left = 0
    const { client, wrapper } = setup({ 'POST /v0/me/rooms/r_1/exit': OK })
    client.setQueryData<readonly MyRoom[]>(queryKeys.rooms, [myRoom({ id: 'r_1' }), myRoom({ id: 'r_2' })])
    client.setQueryData(queryKeys.room('r_1'), ownerDetail())
    const { result } = renderHook(() => useExitRoom(() => (left += 1)), { wrapper })
    await act(() => result.current.mutateAsync({ roomId: 'r_1', name: 'timely' }))
    expect(client.getQueryData<readonly MyRoom[]>(queryKeys.rooms)?.map((r) => r.room.room_id)).toEqual([
      'r_2',
    ])
    expect(client.getQueryData(queryKeys.room('r_1'))).toBeUndefined()
    expect(left).toBe(1)
  })
})

describe('session mutations (api/mutations)', () => {
  const s1 = card({ session_id: 's_1', title: '原来的标题', accepting: true })
  const s2 = card({ session_id: 's_2', title: 'two' })

  function seeded(hub: Record<string, Handler>) {
    const env = setup(hub)
    env.client.setQueryData<readonly SessionCard[]>(queryKeys.sessions, [s1, s2])
    return env
  }
  const sessions = (client: QueryClient) => client.getQueryData<readonly SessionCard[]>(queryKeys.sessions)

  it('runs overlapping changes to one card in order and rolls back only the failed one', async () => {
    let firstDone = false
    let secondStartedEarly = false
    let call = 0
    const env = seeded({
      'PATCH /v0/me/sessions/s_1': async () => {
        call += 1
        if (call === 1) {
          await Bun.sleep(150)
          firstDone = true
          return apiError('internal', 500, 'boom')
        }
        secondStartedEarly = !firstDone
        return { session: { ...s1, accepting: false } }
      },
    })
    const fake: FakeHub = env.hub
    const { result } = renderHook(() => usePatchSession('s_1'), { wrapper: env.wrapper })
    act(() => {
      result.current.mutate({ sessionId: 's_1', patch: { title: '新标题' } })
      result.current.mutate({ sessionId: 's_1', patch: { accepting: false } })
    })
    // Both apply at once.
    await waitFor(() => expect(sessions(env.client)?.[0]?.accepting).toBe(false))
    expect(sessions(env.client)?.[0]?.title).toBe('新标题')
    // A live event for another card lands while the first request is out.
    env.client.setQueryData<readonly SessionCard[]>(queryKeys.sessions, (list) =>
      list?.map((s) => (s.session_id === 's_2' ? { ...s, title: '实时改名' } : s)),
    )
    await waitFor(() => expect(fake.callsTo('PATCH /v0/me/sessions/s_1')).toHaveLength(2))
    await waitFor(() => expect(env.client.isMutating()).toBe(0))
    expect(secondStartedEarly).toBe(false)
    const [one, two] = sessions(env.client) ?? []
    expect(one?.title).toBe('原来的标题')
    expect(one?.accepting).toBe(false)
    expect(two?.title).toBe('实时改名')
    expect(invalidated(env.client, queryKeys.sessions)).toBe(true)
    expect(await screen().findByText('没改成')).toBeDefined()
  })
  it('puts a room back on just that card when removing it fails', async () => {
    const env = seeded({
      'DELETE /v0/me/rooms/r_timely/sessions/s_1': () => apiError('forbidden', 403, 'no'),
    })
    const { result } = renderHook(() => useRemoveFromRoom('s_1'), { wrapper: env.wrapper })
    await act(() =>
      result.current.mutateAsync({ sessionId: 's_1', roomId: 'r_timely' }).catch(() => undefined),
    )
    expect(sessions(env.client)?.[0]?.rooms.map((r) => r.room_id)).toEqual(['r_timely'])
    expect(await screen().findByText('没移出去')).toBeDefined()
    expect(invalidated(env.client, queryKeys.sessions)).toBe(true)
  })
})

describe('paths', () => {
  it('builds room links', () => {
    expect(PATHS.room('r 1')).toBe('/rooms/r%201')
  })
})
