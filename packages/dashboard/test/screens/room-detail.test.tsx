import '../helpers/dom'
import { describe, expect, it, mock } from 'bun:test'
import { within } from '@testing-library/react'
import { renderApp } from '../helpers/app'
import { apiError } from '../helpers/fake-hub'
import { myRoom } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'
import {
  invite,
  JOIN_PROMPT,
  knock,
  memberDetail,
  ownerDetail,
  person,
  ROOM_ID,
  roomHub,
} from '../helpers/room-fixtures'

setupUi()

const PATH = `/app/rooms/${ROOM_ID}`
const group = (name: string) => screen().getByRole('article', { name })

describe('room detail: owner view', () => {
  it('renders the hero, people groups, chips and the join helper', async () => {
    renderApp(PATH, roomHub(ownerDetail()).hub)
    expect(await screen().findByRole('heading', { name: 'timely', level: 1 })).toBeDefined()
    expect(screen().getByText('你是房主')).toBeDefined()
    expect(screen().getByText('3 人 · 5 个 agent')).toBeDefined()
    expect(screen().getByText(/创建$/)).toBeDefined()
    expect(screen().getByRole('button', { name: '解散房间' })).toBeDefined()
    expect(screen().getByRole('link', { name: '全部房间' }).getAttribute('href')).toBe('/app/rooms')
    expect(screen().getByText('/peers:join timely')).toBeDefined()
    const people = screen()
      .getAllByRole('article')
      .map((a: HTMLElement) => a.getAttribute('aria-label'))
    expect(people).toEqual(['gulei', 'zhangwei', 'lina'])
    const me = group('gulei')
    expect(within(me).getByText('我')).toBeDefined()
    expect(within(me).getByText('房主')).toBeDefined()
    expect(within(me).getByText('3 个 agent · 1 个有空')).toBeDefined()
    expect(within(me).queryByRole('button', { name: /^请 .*出房间$/ })).toBeNull()
    const sync = within(me).getByRole('listitem', { name: '通用插件跨 agent session 同步' })
    expect(within(sync).getByText('正在忙')).toBeDefined()
    expect(within(sync).getByText('· Claude Code')).toBeDefined()
    expect(within(group('zhangwei')).getByRole('button', { name: '请 zhangwei 出房间' })).toBeDefined()
    expect(within(group('zhangwei')).getByRole('button', { name: '把 支付网关重构 移出房间' })).toBeDefined()
  })

  it('removes an agent optimistically and rolls back with a toast on failure', async () => {
    const room = roomHub(ownerDetail())
    let fail = true
    room.hub.on(`DELETE /v0/me/rooms/${ROOM_ID}/sessions/s_pay`, () => {
      if (fail) return apiError('forbidden', 403)
      room.set({
        ...room.state(),
        people: room
          .state()
          .people.map((p) => ({ ...p, agents: p.agents.filter((a) => a.card.session_id !== 's_pay') })),
      })
      return { ok: true }
    })
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '把 支付网关重构 移出房间' }))
    expect(await screen().findByText('没移出去')).toBeDefined()
    expect(screen().getByText('这件事只有房主能做。想改的话找房主帮忙。')).toBeDefined()
    expect(await screen().findByRole('listitem', { name: '支付网关重构' })).toBeDefined()
    fail = false
    await u.click(screen().getByRole('button', { name: '把 支付网关重构 移出房间' }))
    await waitFor(() => expect(screen().queryByRole('listitem', { name: '支付网关重构' })).toBeNull())
    expect(within(group('zhangwei')).getByText('还没有 agent 进来')).toBeDefined()
  })

  it('kicks a person into 被请出的人 and restores them', async () => {
    const room = roomHub(ownerDetail())
    room.hub.on(`DELETE /v0/me/rooms/${ROOM_ID}/grants/m_lina`, () => {
      const d = room.state()
      room.set({
        ...d,
        people: d.people.filter((p) => p.member_id !== 'm_lina'),
        kicked: [{ member_id: 'm_lina', member: 'lina', kicked_at: Date.now() }],
      })
      return { ok: true }
    })
    room.hub.on(`POST /v0/me/rooms/${ROOM_ID}/restore/m_lina`, () => {
      room.set(ownerDetail())
      return { ok: true }
    })
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '请 lina 出房间' }))
    // Nothing happens on the first click: the dialog says the invite is rotated too.
    const ask = await screen().findByRole('dialog', { name: '请 lina 出房间' })
    expect(ask.textContent).toContain('邀请码也会换新，之前发出去的邀请都失效')
    await u.click(within(ask).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
    expect(room.hub.callsTo(`DELETE /v0/me/rooms/${ROOM_ID}/grants/m_lina`)).toHaveLength(0)
    await u.click(screen().getByRole('button', { name: '请 lina 出房间' }))
    const confirm = await screen().findByRole('dialog', { name: '请 lina 出房间' })
    await u.click(within(confirm).getByRole('button', { name: '请出房间' }))
    await waitFor(() => expect(screen().queryByRole('article', { name: 'lina' })).toBeNull())
    expect(await screen().findByText('已请 lina 出房间，邀请码换新了，要拉人记得重新复制邀请')).toBeDefined()
    const toggle = screen().getByRole('button', { name: /被请出的 1 人/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await u.click(toggle)
    await u.click(screen().getByRole('button', { name: '恢复 lina' }))
    await waitFor(() =>
      expect(room.hub.callsTo(`POST /v0/me/rooms/${ROOM_ID}/restore/m_lina`)).toHaveLength(1),
    )
    expect(await screen().findByRole('article', { name: 'lina' })).toBeDefined()
    expect(screen().queryByRole('button', { name: /被请出的/ })).toBeNull()
  })

  it('shows the empty state when no agent is in the room', async () => {
    renderApp(
      PATH,
      roomHub(ownerDetail({ people: [person('m_gulei', 'gulei', [], { is_me: true, role: 'owner' })] })).hub,
    )
    expect(await screen().findByRole('region', { name: '还没有 agent 进房间' })).toBeDefined()
  })
})

describe('room detail: 拉朋友进来', () => {
  it('previews a masked invite and copies the full join prompt', async () => {
    renderApp(PATH, roomHub(ownerDetail()).hub)
    await screen().findByText(/Code: inv_••••••••7H58/)
    expect(document.querySelector('[data-invite-preview]')?.textContent).toContain(
      '[peers invite] Join the Peers room "timely" …',
    )
    expect(document.body.textContent).not.toContain('7K3QX9TZ4M2B7H58')
    const u = user()
    // After user-event's setup, which installs its own clipboard stub.
    const writeText = mock(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await u.click(screen().getByRole('button', { name: '复制邀请' }))
    expect(writeText).toHaveBeenCalledWith(JOIN_PROMPT)
    expect(await screen().findByText('已复制，粘到群里吧')).toBeDefined()
  })

  it('says so when the clipboard is blocked', async () => {
    renderApp(PATH, roomHub(ownerDetail()).hub)
    const u = user()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => Promise.reject(new Error('no')) },
      configurable: true,
    })
    await u.click(await screen().findByRole('button', { name: '复制邀请' }))
    expect(await screen().findByText('没复制成功')).toBeDefined()
  })

  it('warns about localhost and a missing public URL', async () => {
    renderApp(PATH, roomHub(ownerDetail({ invite: invite({ loopback: true }), join_prompt: null })).hub)
    expect(await screen().findByText(/邀请里的 Core 地址是 localhost/)).toBeDefined()
    expect(screen().getByText(/Core 还没有对外地址/)).toBeDefined()
    expect(screen().getByRole('button', { name: '复制邀请' }).hasAttribute('disabled')).toBe(true)
  })

  it('rotates, closes and reopens the invite', async () => {
    const room = roomHub(ownerDetail())
    const action = (state: 'active' | 'closed', masked: string) => () => {
      const next = invite({ state, code_masked: masked })
      room.set({ ...room.state(), invite: next, join_prompt: state === 'active' ? JOIN_PROMPT : null })
      return { invite: next, join_prompt: state === 'active' ? JOIN_PROMPT : null }
    }
    room.hub.on(`POST /v0/me/rooms/${ROOM_ID}/invite/rotate`, action('active', 'inv_••••••••AAAA'))
    room.hub.on(`POST /v0/me/rooms/${ROOM_ID}/invite/close`, action('closed', 'inv_••••••••AAAA'))
    room.hub.on(`POST /v0/me/rooms/${ROOM_ID}/invite/reopen`, action('active', 'inv_••••••••BBBB'))
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '换一个邀请码' }))
    expect(await screen().findByText(/AAAA/)).toBeDefined()
    expect(await screen().findByText('换好了，旧邀请码失效了')).toBeDefined()
    await u.click(screen().getByRole('button', { name: '关闭邀请' }))
    expect(await screen().findByRole('heading', { name: '邀请已关闭' })).toBeDefined()
    expect(screen().getByText('之前发出去的邀请都失效了，新的人只能敲门。')).toBeDefined()
    await u.click(screen().getByRole('button', { name: '重新开启（生成新邀请码）' }))
    expect(await screen().findByText(/BBBB/)).toBeDefined()
  })

  it('rolls a failed close back with a toast', async () => {
    const room = roomHub(ownerDetail(), {
      [`POST /v0/me/rooms/${ROOM_ID}/invite/close`]: () => apiError('internal', 500),
    })
    renderApp(PATH, room.hub)
    await user().click(await screen().findByRole('button', { name: '关闭邀请' }))
    expect(await screen().findByText('邀请没关上')).toBeDefined()
    expect(screen().getByRole('button', { name: '复制邀请' })).toBeDefined()
  })
})

describe('room detail: 有人在敲门', () => {
  it('lets one in and declines another', async () => {
    const room = roomHub(ownerDetail(), { 'GET /v0/me/rooms': { rooms: [myRoom({ pending_knocks: 2 })] } })
    const decide = (id: string) => () => {
      const d = room.state()
      room.set({ ...d, knocks: (d.knocks ?? []).filter((k) => k.knock_id !== id) })
      return { knock: knock(id, 'x', { state: 'accepted' }) }
    }
    room.hub.on('POST /v0/me/knocks/k_1/decide', decide('k_1'))
    room.hub.on('POST /v0/me/knocks/k_2/decide', decide('k_2'))
    renderApp(PATH, room.hub)
    const list = await screen().findByRole('list', { name: '敲门的人' })
    expect(within(list).getByText('想让我的 agent 问问 timely 里的接口规范')).toBeDefined()
    const u = user()
    await u.click(within(list).getByRole('button', { name: '给 wangfang 开门' }))
    await waitFor(() => expect(within(list).queryByRole('listitem', { name: 'wangfang 在敲门' })).toBeNull())
    expect(room.hub.callsTo('POST /v0/me/knocks/k_1/decide')[0]?.body).toEqual({ decision: 'accept' })
    expect(await screen().findByText('已开门，wangfang 进来了')).toBeDefined()
    await u.click(within(list).getByRole('button', { name: '先不给 zhoumin 开门' }))
    await waitFor(() =>
      expect(room.hub.callsTo('POST /v0/me/knocks/k_2/decide')[0]?.body).toEqual({ decision: 'decline' }),
    )
    expect(await screen().findByText('现在没人敲门。有人敲门会马上出现在这里。')).toBeDefined()
  })

  it('caps the badge at 99+, previews 3, expands and lets everyone in after a confirm', async () => {
    const many = Array.from({ length: 120 }, (_, i) => knock(`k_${i}`, `knocker-${i}`))
    const room = roomHub(ownerDetail({ knocks: many }))
    for (const k of many)
      room.hub.on(`POST /v0/me/knocks/${k.knock_id}/decide`, { knock: { ...k, state: 'accepted' } })
    renderApp(PATH, room.hub)
    const list = await screen().findByRole('list', { name: '敲门的人' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(screen().getByText('99+')).toBeDefined()
    expect(screen().getByText('120 人在敲门')).toBeDefined()
    const u = user()
    await u.click(screen().getByRole('button', { name: '全部 120 条' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(120)
    await u.click(screen().getByRole('button', { name: '收起' }))
    await u.click(screen().getByRole('button', { name: '全部开门…' }))
    const dialog = await screen().findByRole('dialog', { name: '全部开门' })
    room.set({ ...room.state(), knocks: [] })
    await u.click(within(dialog).getByRole('button', { name: '给 120 个人开门' }))
    await waitFor(() => expect(room.hub.calls.filter((c) => c.path.endsWith('/decide'))).toHaveLength(120))
    expect(await screen().findByText('已开门，120 个人进来了')).toBeDefined()
  })

  it('rolls back and toasts when a decision fails', async () => {
    const room = roomHub(ownerDetail(), { 'POST /v0/me/knocks/k_1/decide': () => apiError('internal', 500) })
    renderApp(PATH, room.hub)
    await user().click(await screen().findByRole('button', { name: '给 wangfang 开门' }))
    expect(await screen().findByText('门没开成')).toBeDefined()
    expect(screen().getByRole('listitem', { name: 'wangfang 在敲门' })).toBeDefined()
  })
})

describe('room detail: member view', () => {
  it('shows the member note, only my agents get ⇥, and nobody gets 请出房间', async () => {
    renderApp(PATH, roomHub(memberDetail()).hub)
    expect(await screen().findByText('你是成员', { selector: 'span' })).toBeDefined()
    expect(screen().getByText(/只有房主 zhangwei 能拉人和管理成员/)).toBeDefined()
    expect(screen().queryByRole('button', { name: '复制邀请' })).toBeNull()
    expect(screen().queryByRole('list', { name: '敲门的人' })).toBeNull()
    expect(screen().getByRole('button', { name: '把 prd2demo 移出房间' })).toBeDefined()
    expect(screen().queryByRole('button', { name: '把 支付网关重构 移出房间' })).toBeNull()
    expect(screen().queryByRole('button', { name: /^请 .*出房间$/ })).toBeNull()
  })

  it('leaves the room after a confirm and goes back to the list', async () => {
    const room = roomHub(memberDetail(), { 'GET /v0/me/rooms': { rooms: [myRoom({ role: 'member' })] } })
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '退出房间' }))
    const dialog = await screen().findByRole('dialog', { name: '退出房间' })
    await u.click(within(dialog).getByRole('button', { name: '退出房间' }))
    await waitFor(() => expect(window.location.pathname).toBe('/app/rooms'))
    expect(room.hub.callsTo(`POST /v0/me/rooms/${ROOM_ID}/exit`)).toHaveLength(1)
    expect(await screen().findByText('已退出 timely')).toBeDefined()
  })
})

describe('room detail: dissolve and states', () => {
  it('dissolves only after the room name is typed', async () => {
    const room = roomHub(ownerDetail())
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '解散房间' }))
    const dialog = await screen().findByRole('dialog', { name: '解散房间' })
    const confirm = within(dialog).getByRole('button', { name: '解散房间' })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    await u.type(within(dialog).getByRole('textbox'), 'timel')
    expect(confirm.hasAttribute('disabled')).toBe(true)
    await u.type(within(dialog).getByRole('textbox'), 'y')
    await u.click(confirm)
    await waitFor(() => expect(window.location.pathname).toBe('/app/rooms'))
    expect(room.hub.callsTo(`DELETE /v0/me/rooms/${ROOM_ID}`)).toHaveLength(1)
    expect(await screen().findByText('timely 已解散')).toBeDefined()
  })

  it('stays put with a toast when dissolving fails', async () => {
    const room = roomHub(ownerDetail(), {
      [`DELETE /v0/me/rooms/${ROOM_ID}`]: () => apiError('forbidden', 403),
    })
    renderApp(PATH, room.hub)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '解散房间' }))
    const dialog = await screen().findByRole('dialog', { name: '解散房间' })
    await u.type(within(dialog).getByRole('textbox'), 'timely{Enter}')
    expect(await screen().findByText('没解散成')).toBeDefined()
    expect(window.location.pathname).toBe(PATH)
  })

  it('says the room was dissolved when it is gone', async () => {
    renderApp(
      PATH,
      roomHub(ownerDetail(), { [`GET /v0/me/rooms/${ROOM_ID}`]: () => apiError('room_not_found', 404) }).hub,
    )
    expect(await screen().findByRole('heading', { name: '这个房间已经解散了' })).toBeDefined()
    expect(screen().getByRole('link', { name: '回到房间列表' }).getAttribute('href')).toBe('/app/rooms')
  })

  it('says I was removed, naming the room when it is known', async () => {
    renderApp(
      PATH,
      roomHub(ownerDetail(), {
        [`GET /v0/me/rooms/${ROOM_ID}`]: () => apiError('forbidden', 403),
        'GET /v0/me/rooms': { rooms: [myRoom()] },
      }).hub,
    )
    expect(await screen().findByRole('heading', { name: '你已经被请出 timely' })).toBeDefined()
  })

  it('offers a retry when loading fails for another reason', async () => {
    const room = roomHub(ownerDetail(), { [`GET /v0/me/rooms/${ROOM_ID}`]: () => apiError('internal', 500) })
    renderApp(PATH, room.hub)
    expect(await screen().findByText('房间没加载出来', {}, { timeout: 3000 })).toBeDefined()
    room.hub.on(`GET /v0/me/rooms/${ROOM_ID}`, () => ownerDetail())
    await user().click(screen().getByRole('button', { name: '重试' }))
    expect(await screen().findByRole('heading', { name: 'timely', level: 1 })).toBeDefined()
  })
})
