import '../helpers/dom'
import { afterEach, describe, expect, it } from 'bun:test'
import { within } from '@testing-library/react'
import { renderApp } from '../helpers/app'
import { screen, setupUi, user, waitFor } from '../helpers/render'
import { bigPeople, knock, memberDetail, ownerDetail, ROOM_ID, roomHub } from '../helpers/room-fixtures'

setupUi()

const PATH = `/app/rooms/${ROOM_ID}`

interface HappyWindow {
  readonly happyDOM: { setViewport(viewport: { width: number; height: number }): void }
}

function viewport(width: number): void {
  ;(window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 800 })
}

afterEach(() => viewport(1280))

const BIG = ownerDetail({ people: [...bigPeople(30)] })

describe('room detail: big rooms', () => {
  it('uses the slim hero with idle count, filters and pages 20 people at a time', async () => {
    renderApp(PATH, roomHub(BIG).hub)
    expect(await screen().findByRole('heading', { name: 'timely', level: 1 })).toBeDefined()
    expect(screen().getByRole('link', { name: '回到全部房间' })).toBeDefined()
    expect(screen().getByText('30 人 · 67 个 agent')).toBeDefined()
    expect(screen().getByText('32 个有空')).toBeDefined()
    expect(screen().getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen().getByRole('button', { name: '有空 32' })).toBeDefined()
    expect(screen().getByRole('button', { name: '正在忙 32' })).toBeDefined()
    expect(screen().getByRole('button', { name: '离线 3' })).toBeDefined()
    expect(screen().getByText('已显示 20 / 30 人')).toBeDefined()
    // The overscan keeps a whole page mounted, so a full-page capture has no blank rows.
    await waitFor(() => expect(screen().getAllByRole('article').length).toBe(20))
    await user().click(screen().getByRole('button', { name: '加载更多' }))
    expect(await screen().findByText('已显示 30 / 30 人')).toBeDefined()
    expect(screen().queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('virtualizes long lists: only the groups near the viewport are mounted', async () => {
    renderApp(PATH, roomHub(ownerDetail({ people: [...bigPeople(80)] })).hub)
    await screen().findByText('已显示 20 / 80 人')
    const u = user()
    await u.click(screen().getByRole('button', { name: '加载更多' }))
    await u.click(await screen().findByRole('button', { name: '加载更多' }))
    expect(await screen().findByText('已显示 60 / 80 人')).toBeDefined()
    expect(screen().getAllByRole('article').length).toBeLessThan(60)
  })

  it('opens my group capped at 6 chips, collapses the rest, and expands on demand', async () => {
    renderApp(PATH, roomHub(BIG).hub)
    const me = await screen().findByRole('article', { name: 'gulei' })
    expect(within(me).getAllByRole('listitem')).toHaveLength(6)
    const u = user()
    await u.click(within(me).getByRole('button', { name: '再看 3 个' }))
    expect(within(me).getAllByRole('listitem')).toHaveLength(9)
    const other = screen().getByRole('article', { name: 'person-1' })
    expect(within(other).queryByRole('list')).toBeNull()
    const expand = within(other).getByRole('button', { name: '展开 person-1 的 agent' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    await u.click(expand)
    expect(within(other).getAllByRole('listitem')).toHaveLength(2)
    await u.click(within(other).getByRole('button', { name: '收起 person-1 的 agent' }))
    expect(within(other).queryByRole('list')).toBeNull()
  })

  it('filters by status, mine only and search', async () => {
    renderApp(PATH, roomHub(BIG).hub)
    await screen().findByRole('article', { name: 'gulei' })
    const u = user()
    await u.click(screen().getByRole('button', { name: '离线 3' }))
    const me = screen().getByRole('article', { name: 'gulei' })
    expect(within(me).getAllByRole('listitem')).toHaveLength(3)
    expect(screen().getAllByRole('article')).toHaveLength(1)
    expect(screen().getByText('已显示 1 / 1 人')).toBeDefined()
    await u.click(screen().getByRole('button', { name: '全部' }))
    await u.click(screen().getByRole('switch', { name: '只看我的' }))
    expect(screen().getAllByRole('article')).toHaveLength(1)
    await u.click(screen().getByRole('switch', { name: '只看我的' }))
    await u.type(screen().getByRole('searchbox', { name: '找人或 agent' }), 'agent 7-1')
    await waitFor(() => expect(screen().getAllByRole('article')).toHaveLength(1))
    expect(screen().getByRole('article', { name: 'person-7' })).toBeDefined()
    await u.clear(screen().getByRole('searchbox', { name: '找人或 agent' }))
    await u.type(screen().getByRole('searchbox', { name: '找人或 agent' }), 'nobody')
    expect(await screen().findByText(/没有符合的人或 agent/)).toBeDefined()
  })
})

describe('room detail: phones', () => {
  it('splits into 成员 / 邀请 / 敲门 tabs and opens the invite tab after creating', async () => {
    viewport(390)
    const many = Array.from({ length: 120 }, (_, i) => knock(`k_${i}`, `knocker-${i}`))
    renderApp(`${PATH}?invite=1`, roomHub(ownerDetail({ knocks: many })).hub)
    const tabs = await screen().findByRole('tablist', { name: '房间分区' })
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t: HTMLElement) => t.textContent),
    ).toEqual(['成员', '邀请', '敲门 99+'])
    expect(screen().getByRole('tab', { name: '邀请' }).getAttribute('aria-selected')).toBe('true')
    expect(screen().getByRole('button', { name: '复制邀请' })).toBeDefined()
    const u = user()
    await u.click(screen().getByRole('tab', { name: '敲门 99+' }))
    expect(await screen().findByRole('list', { name: '敲门的人' })).toBeDefined()
    await u.click(screen().getByRole('tab', { name: '成员' }))
    expect(await screen().findByRole('article', { name: 'zhangwei' })).toBeDefined()
  })

  it('manages a person from the bottom sheet', async () => {
    viewport(390)
    const room = roomHub(ownerDetail())
    room.hub.on(`DELETE /v0/me/rooms/${ROOM_ID}/sessions/s_pay`, { ok: true })
    room.hub.on(`DELETE /v0/me/rooms/${ROOM_ID}/grants/m_lina`, { ok: true })
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '管理 zhangwei' }))
    const sheet = await screen().findByRole('dialog', { name: '管理 zhangwei' })
    expect(within(sheet).getByText('他在这个房间有 1 个 agent。')).toBeDefined()
    await u.click(within(sheet).getByRole('button', { name: '把他的 agent 全部移出' }))
    await waitFor(() =>
      expect(room.hub.callsTo(`DELETE /v0/me/rooms/${ROOM_ID}/sessions/s_pay`)).toHaveLength(1),
    )
    expect(await screen().findByText('zhangwei 的 agent 都移出去了')).toBeDefined()
    await u.click(screen().getByRole('button', { name: '管理 lina' }))
    const second = await screen().findByRole('dialog', { name: '管理 lina' })
    await u.click(within(second).getByRole('button', { name: '请出房间（之后不能再用邀请码进来）' }))
    const confirm = await screen().findByRole('dialog', { name: '请 lina 出房间' })
    await u.click(within(confirm).getByRole('button', { name: '请出房间' }))
    await waitFor(() =>
      expect(room.hub.callsTo(`DELETE /v0/me/rooms/${ROOM_ID}/grants/m_lina`)).toHaveLength(1),
    )
    await u.click(screen().getByRole('button', { name: '管理 zhangwei' }))
    await u.click(within(await screen().findByRole('dialog')).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
  })

  it('rolls back removing all agents when one removal fails', async () => {
    viewport(390)
    const room = roomHub(ownerDetail())
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '管理 zhangwei' }))
    await u.click(
      within(await screen().findByRole('dialog')).getByRole('button', { name: '把他的 agent 全部移出' }),
    )
    expect(await screen().findByText('没全部移出去')).toBeDefined()
    expect(screen().getByRole('listitem', { name: '支付网关重构' })).toBeDefined()
  })

  it('puts 请出房间 behind a quiet ⋯ menu in big rooms', async () => {
    const room = roomHub(BIG)
    room.hub.on(`DELETE /v0/me/rooms/${ROOM_ID}/grants/m_p1`, { ok: true })
    renderApp(PATH, room.hub)
    const group = await screen().findByRole('article', { name: 'person-1' })
    expect(within(group).queryByRole('button', { name: '请出房间' })).toBeNull()
    expect(within(group).queryByRole('button', { name: '请 person-1 出房间' })).toBeNull()
    const u = user()
    await u.click(within(group).getByRole('button', { name: '管理 person-1' }))
    await u.click(await screen().findByRole('menuitem', { name: '请 person-1 出房间' }))
    const confirm = await screen().findByRole('dialog', { name: '请 person-1 出房间' })
    await u.click(within(confirm).getByRole('button', { name: '请出房间' }))
    await waitFor(() =>
      expect(room.hub.callsTo(`DELETE /v0/me/rooms/${ROOM_ID}/grants/m_p1`)).toHaveLength(1),
    )
  })

  it('outlines my own group in violet in every room', async () => {
    renderApp(PATH, roomHub(ownerDetail()).hub)
    const me = await screen().findByRole('article', { name: 'gulei' })
    expect(me.className).toContain('border-primary')
    expect(screen().getByRole('article', { name: 'zhangwei' }).className).not.toContain('border-primary')
  })

  it('phones get a one-row hero and dissolve from its ⋯ sheet', async () => {
    viewport(390)
    renderApp(PATH, roomHub(ownerDetail()).hub)
    expect(await screen().findByRole('heading', { name: 'timely', level: 1 })).toBeDefined()
    expect(document.querySelector('[data-hero="phone"]')).not.toBeNull()
    expect(screen().queryByRole('button', { name: '解散房间' })).toBeNull()
    const u = user()
    await u.click(screen().getByRole('button', { name: '管理房间 timely' }))
    const sheet = await screen().findByRole('dialog', { name: '管理房间 timely' })
    await u.click(within(sheet).getByRole('button', { name: '解散房间' }))
    const confirm = await screen().findByRole('dialog', { name: '解散房间' })
    expect(within(confirm).getByRole('textbox')).toBeDefined()
  })

  it('members leave from the phone hero sheet', async () => {
    viewport(390)
    renderApp(PATH, roomHub(memberDetail()).hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '管理房间 timely' }))
    const sheet = await screen().findByRole('dialog', { name: '管理房间 timely' })
    expect(within(sheet).getByText(/退出后你的 agent 都会离开/)).toBeDefined()
    await u.click(within(sheet).getByRole('button', { name: '退出房间' }))
    expect(await screen().findByRole('dialog', { name: '退出房间' })).toBeDefined()
  })
})
