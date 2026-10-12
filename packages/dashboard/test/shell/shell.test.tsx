import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { act, within } from '@testing-library/react'
import { isActive } from '../../src/components/shell/nav'
import { memberHub, renderApp } from '../helpers/app'
import { apiError, FakeEventSource } from '../helpers/fake-hub'
import { card, myRoom } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

function hub() {
  return memberHub({
    'GET /v0/me/sessions': { sessions: [card(), card({ session_id: 's_2', title: 'two' })] },
    'GET /v0/me/rooms': {
      rooms: [myRoom({ pending_knocks: 120 }), myRoom({ id: 'r_2', name: 'pay', pending_knocks: 3 })],
    },
  })
}

describe('isActive', () => {
  it('matches home exactly and sections by prefix', () => {
    expect(isActive('/', '/')).toBe(true)
    expect(isActive('/', '')).toBe(true)
    expect(isActive('/', '/asks')).toBe(false)
    expect(isActive('/rooms', '/rooms/r_1')).toBe(true)
    expect(isActive('/rooms', '/roomsx')).toBe(false)
  })
})

describe('app shell', () => {
  it('shows nav pills with badges, marks the active one and navigates', async () => {
    renderApp('/app/', hub())
    const nav = await screen().findByRole('navigation', { name: '主导航' })
    await waitFor(() => expect(within(nav).getByText('99+')).toBeDefined())
    const home = within(nav).getByRole('link', { name: /我的 agent/ })
    expect(home.getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByText('2 个 agent')).toBeDefined()
    expect(within(nav).getByText('123 人在敲门')).toBeDefined()
    await user().click(within(nav).getByRole('link', { name: '问答' }))
    expect(await screen().findByRole('heading', { name: '问答' }, { timeout: 3000 })).toBeDefined()
    expect(within(nav).getByRole('link', { name: '问答' }).getAttribute('aria-current')).toBe('page')
    const tabs = screen().getByRole('navigation', { name: '底部导航' })
    expect(within(tabs).getByRole('link', { name: /问答/ }).getAttribute('aria-current')).toBe('page')
  })
  it('switches theme and reduced motion from the avatar menu, then logs out', async () => {
    const h = hub()
    h.on('POST /v0/me/logout', { ok: true })
    renderApp('/app/', h)
    const u = user()
    const open = async () => u.click(await screen().findByRole('button', { name: '账户菜单（gulei）' }))
    await open()
    await u.click(await screen().findByRole('menuitemradio', { name: '深色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    await open()
    await u.click(await screen().findByRole('menuitemradio', { name: '跟随系统' }))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    await open()
    await u.click(await screen().findByRole('menuitemcheckbox', { name: '减少动态效果' }))
    expect(document.documentElement.dataset.reduceMotion).toBe('false')
    await open()
    await u.click(await screen().findByRole('menuitem', { name: '退出登录' }))
    expect(await screen().findByRole('heading', { name: '已退出登录' }, { timeout: 3000 })).toBeDefined()
    expect(h.callsTo('POST /v0/me/logout')).toHaveLength(1)
  })
  it('keeps the member signed in, with a danger toast, when logout fails', async () => {
    const h = hub()
    h.on('POST /v0/me/logout', () => apiError('forbidden', 403, 'origin'))
    renderApp('/app/', h)
    const u = user()
    await u.click(await screen().findByRole('button', { name: '账户菜单（gulei）' }))
    await u.click(await screen().findByRole('menuitem', { name: '退出登录' }))
    expect(await screen().findByText('没退出成功，你还登录着')).toBeDefined()
    expect(location.search).not.toContain('signed_out')
    expect(screen().queryByRole('heading', { name: '已退出登录' })).toBeNull()
    expect(screen().getByRole('button', { name: '账户菜单（gulei）' })).toBeDefined()
  })
  it('sends signed-out members to the login page', async () => {
    renderApp('/app/asks', memberHub({ 'GET /v0/me': () => apiError('unauthorized', 401) }))
    expect(await screen().findByRole('heading', { name: '还没登录' }, { timeout: 3000 })).toBeDefined()
    expect(location.pathname).toBe('/app/login')
  })
  it('drives the Core pill from the event stream and dims stale data while disconnected', async () => {
    renderApp('/app/', hub())
    await screen().findByRole('article', { name: 'two' })
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    expect(screen().getByText('正在连 Core…')).toBeDefined()
    act(() => FakeEventSource.latest().open())
    expect(screen().getByText('Core 已连接')).toBeDefined()
    act(() => FakeEventSource.latest().fail())
    expect(screen().getByText('正在连 Core…')).toBeDefined()
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 2500 })
    act(() => FakeEventSource.latest().fail())
    expect(screen().getByText('连不上 Core')).toBeDefined()
    expect(screen().getByRole('alert').textContent).toContain('连不上 Core（localhost）')
    expect(screen().getByText('（上次的数据，等 Core…）')).toBeDefined()
    await user().click(screen().getByRole('button', { name: '现在重试' }))
    expect(FakeEventSource.instances.length).toBe(3)
    act(() => FakeEventSource.latest().open())
    expect(screen().getByText('Core 已连接')).toBeDefined()
    expect(screen().queryByText('（上次的数据，等 Core…）')).toBeNull()
  })
  it('applies live session events to the cards', async () => {
    renderApp('/app/', hub())
    await screen().findByRole('article', { name: 'two' })
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    act(() => {
      FakeEventSource.latest().open()
      FakeEventSource.latest().emit('session', { session: card({ session_id: 's_2', title: '实时改名' }) })
    })
    expect(await screen().findByRole('article', { name: '实时改名' })).toBeDefined()
  })
})
