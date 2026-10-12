import '../helpers/dom'
import { afterEach, describe, expect, it } from 'bun:test'
import { within } from '@testing-library/react'
import { ROOMS_VIEW_KEY } from '../../src/components/rooms/list/my-rooms'
import { memberHub, renderApp } from '../helpers/app'
import { apiError } from '../helpers/fake-hub'
import { card, myRoom, NOW } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'
import { knock, searchRoom } from '../helpers/room-fixtures'

setupUi()

interface HappyWindow {
  readonly happyDOM: { setViewport(viewport: { width: number; height: number }): void }
}

afterEach(() => {
  ;(window as unknown as HappyWindow).happyDOM.setViewport({ width: 1280, height: 800 })
  localStorage.removeItem(ROOMS_VIEW_KEY)
})

/** 14 rooms: 3 owned (two with knocks), 11 joined; plus one pending knock of mine. */
const ROOMS = Array.from({ length: 14 }, (_, i) =>
  myRoom({
    id: `r_${i}`,
    name: `room-${String(i).padStart(2, '0')}`,
    role: i < 3 ? 'owner' : 'member',
    people: i + 1,
    agents: i,
    pending_knocks: i === 0 ? 120 : i === 1 ? 2 : 0,
    last_activity_at: i === 13 ? null : NOW - i * 60_000,
  }),
)

function hub(routes = {}) {
  return memberHub({
    'GET /v0/me/rooms': { rooms: ROOMS },
    'GET /v0/me/sessions': { sessions: [card({ rooms: [{ room_id: 'r_3', handle: 'sync' }] })] },
    'GET /v0/me/knocks': { knocks: [knock('k_mine', 'gulei', { room_id: 'r_design' })] },
    'GET /v0/rooms/search': {
      rooms: [searchRoom('r_design', 'design', { owner: 'wangfang', member_count: 6, my_state: 'knocking' })],
    },
    ...routes,
  })
}

const table = () => screen().getByRole('table', { name: '我的房间' })
const bodyRows = () => within(table()).getAllByRole('row').slice(1)

describe('rooms: many rooms', () => {
  it('switches to a table with counts, tabs, the knock strip and paging', async () => {
    renderApp('/app/rooms', hub())
    expect(await screen().findByText('共 14 个')).toBeDefined()
    await waitFor(() => expect(screen().getByRole('button', { name: '等开门 1' })).toBeDefined())
    expect(screen().getByRole('button', { name: '全部 15' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen().getByRole('button', { name: '我建的 3' })).toBeDefined()
    expect(screen().getByRole('button', { name: '我加入的 11' })).toBeDefined()
    const strip = screen().getByRole('region', { name: '等你开门' })
    expect(
      within(strip)
        .getAllByRole('link')
        .map((a: HTMLElement) => a.textContent),
    ).toEqual(['room-0099+120 人在敲门', 'room-0122 人在敲门'])
    expect(bodyRows()).toHaveLength(12)
    expect(within(bodyRows()[0] as HTMLElement).getByRole('link', { name: 'room-00' })).toBeDefined()
    expect(screen().getByText('已显示 12 / 15')).toBeDefined()
    await user().click(screen().getByRole('button', { name: '再看 3 个' }))
    expect(bodyRows()).toHaveLength(15)
    expect(screen().queryByRole('button', { name: /再看/ })).toBeNull()
    expect(screen().getByText('0 / 0 · 还没人来')).toBeDefined()
    expect(screen().getByText('1 / 3')).toBeDefined()
  })

  it('filters by group and text, and sorts', async () => {
    renderApp('/app/rooms', hub())
    await screen().findByRole('table', { name: '我的房间' })
    const u = user()
    await u.click(screen().getByRole('button', { name: '我建的 3' }))
    expect(bodyRows()).toHaveLength(3)
    await u.click(await screen().findByRole('button', { name: '等开门 1' }))
    expect(bodyRows()).toHaveLength(1)
    expect(within(table()).getByText('design')).toBeDefined()
    expect(within(table()).getByText('wangfang')).toBeDefined()
    await u.click(screen().getByRole('button', { name: /^全部/ }))
    await u.selectOptions(screen().getByRole('combobox', { name: '排序' }), '人数')
    expect(within(bodyRows()[0] as HTMLElement).getByText('room-13')).toBeDefined()
    await u.selectOptions(screen().getByRole('combobox', { name: '排序' }), '名字')
    expect(within(bodyRows()[0] as HTMLElement).getByText('design')).toBeDefined()
    await u.type(screen().getByRole('searchbox', { name: '在我的房间里找' }), 'room-1')
    expect(bodyRows()).toHaveLength(4)
    await u.clear(screen().getByRole('searchbox', { name: '在我的房间里找' }))
    await u.type(screen().getByRole('searchbox', { name: '在我的房间里找' }), 'nothing')
    expect(screen().getByText(/这一组里没有房间/)).toBeDefined()
  })

  it('withdraws a knock from the table', async () => {
    const h = hub({ 'DELETE /v0/me/knocks/k_mine': { ok: true } })
    renderApp('/app/rooms', h)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '等开门 1' }))
    await u.click(screen().getByRole('button', { name: '撤回敲 design 的门' }))
    await waitFor(() => expect(h.callsTo('DELETE /v0/me/knocks/k_mine')).toHaveLength(1))
  })

  it('remembers the card view', async () => {
    renderApp('/app/rooms', hub())
    await screen().findByRole('table', { name: '我的房间' })
    await user().click(screen().getByRole('button', { name: '卡片视图' }))
    expect(localStorage.getItem(ROOMS_VIEW_KEY)).toBe('grid')
    expect(screen().queryByRole('table')).toBeNull()
    expect(screen().getByRole('list', { name: '我的房间' })).toBeDefined()
    expect(screen().getByRole('button', { name: '卡片视图' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('becomes a two-line list on phones', async () => {
    ;(window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 800 })
    renderApp('/app/rooms', hub())
    const list = await screen().findByRole('list', { name: '我的房间' })
    expect(screen().queryByRole('table')).toBeNull()
    expect(within(list).getAllByRole('listitem')).toHaveLength(12)
    expect(within(list).getAllByText(/^房主 /).length).toBeGreaterThan(0)
  })

  it('names unknown knock rooms and still works when my knocks fail', async () => {
    renderApp(
      '/app/rooms',
      hub({ 'GET /v0/rooms/search': { rooms: [] }, 'GET /v0/me/knocks': () => apiError('internal', 500) }),
    )
    expect(await screen().findByRole('table', { name: '我的房间' })).toBeDefined()
    expect(screen().getByRole('button', { name: '等开门 0' })).toBeDefined()
  })

  it('labels a knock row whose room the search does not know', async () => {
    renderApp('/app/rooms', hub({ 'GET /v0/rooms/search': { rooms: [] } }))
    await user().click(await screen().findByRole('button', { name: '等开门 1' }))
    expect(within(table()).getByText('等开门的房间')).toBeDefined()
  })
})
