import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { within } from '@testing-library/react'
import { apiError } from '../helpers/fake-hub'
import { screen, setupUi, user, waitFor } from '../helpers/render'
import { adminHub, adminMember, adminRoom, SETTINGS, STATUS } from './fixtures'
import { renderOperator } from './render-operator'

setupUi()

const signedOut = () => apiError('unauthorized', 401, 'sign in with the admin token')

describe('operator: sign in', () => {
  it('asks for the admin token, posts it and opens the console', async () => {
    let signedIn = false
    const hub = adminHub({
      'GET /v0/admin/whoami': () => (signedIn ? { admin: true } : signedOut()),
      'POST /v0/admin/login': () => {
        signedIn = true
        return { ok: true }
      },
    })
    renderOperator(hub)
    expect(await screen().findByRole('heading', { name: '登录 Core 运维' })).toBeDefined()
    const submit = screen().getByRole('button', { name: '登录' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    await user().type(screen().getByLabelText('管理令牌'), '  apa_secret  ')
    await user().click(submit)
    await waitFor(() => expect(hub.callsTo('POST /v0/admin/login')[0]?.body).toEqual({ token: 'apa_secret' }))
    expect(await screen().findByRole('heading', { name: 'Core 运维' })).toBeDefined()
  })
  it('explains a wrong token', async () => {
    const hub = adminHub({ 'GET /v0/admin/whoami': signedOut, 'POST /v0/admin/login': signedOut })
    renderOperator(hub)
    await user().type(await screen().findByLabelText('管理令牌'), 'nope')
    await user().click(screen().getByRole('button', { name: '登录' }))
    expect(await screen().findByText(/令牌不对/)).toBeDefined()
  })
  it('shows a retryable error when the admin listener is unreachable', async () => {
    let calls = 0
    const hub = adminHub({
      'GET /v0/admin/whoami': () => {
        calls += 1
        return calls <= 2 ? apiError('internal', 500) : { admin: true }
      },
    })
    renderOperator(hub)
    expect(await screen().findByText('连不上 Core', {}, { timeout: 3000 })).toBeDefined()
    await user().click(screen().getByRole('button', { name: '再试一次' }))
    expect(await screen().findByRole('heading', { name: 'Core 运维' })).toBeDefined()
  })
  it('goes back to sign-in when a request comes back 401', async () => {
    const hub = adminHub({ 'GET /v0/admin/rooms': signedOut })
    renderOperator(hub)
    expect(await screen().findByRole('heading', { name: '登录 Core 运维' })).toBeDefined()
  })
  it('switches theme and motion from the menu', async () => {
    renderOperator(adminHub())
    await user().click(await screen().findByRole('button', { name: '运维菜单' }))
    await user().click(await screen().findByRole('menuitemradio', { name: '深色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    await user().click(await screen().findByRole('button', { name: '运维菜单' }))
    const motion = await screen().findByRole('menuitemcheckbox', { name: '减少动态效果' })
    const before = motion.getAttribute('aria-checked')
    await user().click(motion)
    await user().click(await screen().findByRole('button', { name: '运维菜单' }))
    const after = await screen().findByRole('menuitemcheckbox', { name: '减少动态效果' })
    expect(after.getAttribute('aria-checked')).not.toBe(before)
    await user().click(await screen().findByRole('menuitemradio', { name: '跟随系统' }))
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
  it('signs out from the menu', async () => {
    const hub = adminHub({ 'POST /v0/admin/logout': { ok: true } })
    renderOperator(hub)
    await user().click(await screen().findByRole('button', { name: '运维菜单' }))
    await user().click(await screen().findByRole('menuitem', { name: '退出运维' }))
    expect(await screen().findByRole('heading', { name: '登录 Core 运维' })).toBeDefined()
    expect(hub.callsTo('POST /v0/admin/logout')).toHaveLength(1)
  })
  it('stays signed in and says so when logout fails', async () => {
    let fail = true
    const hub = adminHub({
      'POST /v0/admin/logout': () => (fail ? apiError('internal', 500, 'boom') : { ok: true }),
    })
    renderOperator(hub)
    await user().click(await screen().findByRole('button', { name: '运维菜单' }))
    await user().click(await screen().findByRole('menuitem', { name: '退出运维' }))
    expect(await screen().findByText('没退出成功，你还登录着')).toBeDefined()
    expect(screen().queryByRole('heading', { name: '登录 Core 运维' })).toBeNull()
    expect(screen().getByRole('heading', { name: 'Core 状态' })).toBeDefined()
    fail = false
    await user().click(screen().getByRole('button', { name: '再试一次' }))
    expect(await screen().findByRole('heading', { name: '登录 Core 运维' })).toBeDefined()
  })
  it('treats an already-expired admin session as signed out', async () => {
    renderOperator(adminHub({ 'POST /v0/admin/logout': signedOut }))
    await user().click(await screen().findByRole('button', { name: '运维菜单' }))
    await user().click(await screen().findByRole('menuitem', { name: '退出运维' }))
    expect(await screen().findByRole('heading', { name: '登录 Core 运维' })).toBeDefined()
  })
})

describe('operator: status and settings', () => {
  it('shows the hub status card', async () => {
    renderOperator(adminHub())
    const card = (await screen().findByRole('heading', { name: 'Core 状态' })).closest('div.relative')
    if (!(card instanceof HTMLElement)) throw new Error('no status card')
    const view = within(card)
    expect(view.getByText('v0.1.0')).toBeDefined()
    expect(view.getByText('已运行 3 小时 12 分钟')).toBeDefined()
    expect(view.getByText('https://peers.example.com')).toBeDefined()
    expect(view.getByText('在线 agent')).toBeDefined()
    expect(view.queryByText(/公开地址是 localhost/)).toBeNull()
  })
  it('warns when the public URL is loopback', async () => {
    renderOperator(
      adminHub({
        'GET /v0/admin/status': { ...STATUS, public_url: 'http://127.0.0.1:7337' },
        'GET /v0/admin/settings': { ...SETTINGS, public_url: 'http://127.0.0.1:7337' },
      }),
    )
    expect((await screen().findAllByText(/公开地址是 localhost/)).length).toBe(2)
  })
  it('saves only what changed and validates the URL first', async () => {
    const hub = adminHub({
      'PATCH /v0/admin/settings': (call) => ({ ...SETTINGS, ...(call.body as object) }),
    })
    renderOperator(hub)
    const url = await screen().findByLabelText('公开地址')
    const save = screen().getByRole('button', { name: '保存' })
    expect(save.hasAttribute('disabled')).toBe(true)
    await user().clear(url)
    await user().type(url, 'peers.example.org')
    expect(screen().getByText('要以 http:// 或 https:// 开头')).toBeDefined()
    expect(save.hasAttribute('disabled')).toBe(true)
    await user().clear(url)
    await user().type(url, 'https://peers.example.org')
    await user().click(screen().getByRole('radio', { name: '开放注册' }))
    expect(screen().getByText(/任何能连上 Core 的人都能自己注册/)).toBeDefined()
    await user().click(save)
    await waitFor(() =>
      expect(hub.callsTo('PATCH /v0/admin/settings')[0]?.body).toEqual({
        public_url: 'https://peers.example.org',
        registration: 'open',
      }),
    )
    expect(await screen().findByText('已保存，立即生效')).toBeDefined()
  })
  it('shows read-only startup values', async () => {
    renderOperator(adminHub())
    expect(await screen().findByText('消息保留')).toBeDefined()
    expect(screen().getByText('30 天')).toBeDefined()
    expect(screen().getByText('15 秒 / 1 分钟')).toBeDefined()
  })
  it('explains a refused save', async () => {
    const hub = adminHub({ 'PATCH /v0/admin/settings': () => apiError('invalid_params', 400) })
    renderOperator(hub)
    await user().click(await screen().findByRole('radio', { name: '开放注册' }))
    await user().click(screen().getByRole('button', { name: '保存' }))
    expect(await screen().findByText('没保存上')).toBeDefined()
  })
  it('offers a retry when status or settings fail to load', async () => {
    renderOperator(
      adminHub({
        'GET /v0/admin/status': () => apiError('internal', 500),
        'GET /v0/admin/settings': () => apiError('internal', 500),
      }),
    )
    expect(await screen().findByText('读不到 Core 状态', {}, { timeout: 3000 })).toBeDefined()
    expect(await screen().findByText('读不到设置', {}, { timeout: 3000 })).toBeDefined()
  })
})

describe('operator: rooms and members', () => {
  it('lists every room and dissolves one after typing its name', async () => {
    const hub = adminHub({ 'DELETE /v0/admin/rooms/r_pay': { ok: true } })
    renderOperator(hub)
    const list = await screen().findByRole('list', { name: '所有房间' })
    expect(within(list).getByText('支付联调')).toBeDefined()
    expect(within(list).getByText('房主 zhang-wei · pay-integration')).toBeDefined()
    expect(within(list).getByText('2 人在敲门')).toBeDefined()
    expect(within(list).getByText('还没人说话')).toBeDefined()
    await user().click(within(list).getByRole('button', { name: '解散 支付联调' }))
    const dialog = await screen().findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: '解散房间' })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    await user().type(within(dialog).getByLabelText(/确认/), 'pay-integration')
    await user().click(confirm)
    await waitFor(() => expect(hub.callsTo('DELETE /v0/admin/rooms/r_pay')).toHaveLength(1))
    expect(await screen().findByText('已解散 支付联调')).toBeDefined()
  })
  it('shows why a dissolve failed', async () => {
    renderOperator(adminHub({ 'DELETE /v0/admin/rooms/r_timely': () => apiError('room_not_found', 404) }))
    await user().click(await screen().findByRole('button', { name: '解散 timely' }))
    const dialog = await screen().findByRole('dialog')
    await user().type(within(dialog).getByLabelText(/确认/), 'timely')
    await user().click(within(dialog).getByRole('button', { name: '解散房间' }))
    expect(await within(dialog).findByText('没做成')).toBeDefined()
    await user().click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
  })
  it('filters and pages long lists', async () => {
    const rooms = Array.from({ length: 45 }, (_, i) => adminRoom(`r_${i}`, `room-${i}`))
    renderOperator(adminHub({ 'GET /v0/admin/rooms': { rooms } }))
    const list = await screen().findByRole('list', { name: '所有房间' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(30)
    expect(screen().getByText('已显示 30 / 45')).toBeDefined()
    await user().click(screen().getByRole('button', { name: '再看 15 个' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(45)
    await user().type(screen().getByLabelText('找房间'), 'room-4')
    expect(within(list).getAllByRole('listitem')).toHaveLength(6)
    await user().clear(screen().getByLabelText('找房间'))
    await user().type(screen().getByLabelText('找房间'), 'zzz')
    expect(await screen().findByText('没找到匹配的房间')).toBeDefined()
  })
  it('shows empty lists with what to do next', async () => {
    renderOperator(
      adminHub({ 'GET /v0/admin/rooms': { rooms: [] }, 'GET /v0/admin/members': { members: [] } }),
    )
    expect(await screen().findByText('还没有房间')).toBeDefined()
    expect(screen().getByText('还没有成员')).toBeDefined()
  })
  it('revokes a member’s tokens', async () => {
    const hub = adminHub({ 'DELETE /v0/admin/members/m_zhang/tokens': { revoked: 2 } })
    renderOperator(hub)
    const list = await screen().findByRole('list', { name: '所有成员' })
    await user().type(screen().getByLabelText('找成员'), 'zhang')
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    await user().click(within(list).getByRole('button', { name: '吊销 zhang-wei 的令牌' }))
    await user().click(within(await screen().findByRole('dialog')).getByRole('button', { name: '吊销令牌' }))
    expect(await screen().findByText('已吊销 zhang-wei 的 2 个令牌')).toBeDefined()
  })
  it('says when a member had no tokens left', async () => {
    const members = [adminMember('m_x', 'an-extremely-long-member-name-x', { sessions: 0 })]
    renderOperator(
      adminHub({
        'GET /v0/admin/members': { members },
        'DELETE /v0/admin/members/m_x/tokens': { revoked: 0 },
      }),
    )
    await user().click(await screen().findByRole('button', { name: /吊销 an-extremely/ }))
    await user().click(within(await screen().findByRole('dialog')).getByRole('button', { name: '吊销令牌' }))
    expect(await screen().findByText('an-extremely-long-member-name-x 没有能用的令牌')).toBeDefined()
  })
  it('offers a retry when the lists fail to load', async () => {
    renderOperator(
      adminHub({
        'GET /v0/admin/rooms': () => apiError('internal', 500),
        'GET /v0/admin/members': () => apiError('internal', 500),
      }),
    )
    expect(await screen().findByText('读不到房间列表', {}, { timeout: 3000 })).toBeDefined()
    expect(await screen().findByText('读不到成员列表', {}, { timeout: 3000 })).toBeDefined()
  })
})

describe('operator: admin token', () => {
  it('rotates the token and shows the new one once', async () => {
    const hub = adminHub({
      'POST /v0/admin/rotate-admin-token': { admin_token: 'apa_new_token', persisted: false },
    })
    renderOperator(hub)
    await user().click(await screen().findByRole('button', { name: '换一个管理令牌…' }))
    await user().click(within(await screen().findByRole('dialog')).getByRole('button', { name: '换令牌' }))
    const shown = await screen().findByRole('dialog', { name: '新的管理令牌' })
    expect(within(shown).getByText('apa_new_token')).toBeDefined()
    expect(within(shown).getByText(/内存模式/)).toBeDefined()
    const u = user()
    await u.click(within(shown).getByRole('button', { name: '复制令牌' }))
    expect(await screen().findByText('已复制新令牌')).toBeDefined()
    expect(await navigator.clipboard.readText()).toBe('apa_new_token')
    await user().click(within(shown).getByRole('button', { name: '好了' }))
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
  })
  it('says where a persisted token went, and explains failures', async () => {
    let attempt = 0
    const hub = adminHub({
      'POST /v0/admin/rotate-admin-token': () => {
        attempt += 1
        return attempt === 1 ? apiError('internal', 500) : { admin_token: 'apa_2', persisted: true }
      },
    })
    renderOperator(hub)
    await user().click(await screen().findByRole('button', { name: '换一个管理令牌…' }))
    const dialog = await screen().findByRole('dialog')
    await user().click(within(dialog).getByRole('button', { name: '换令牌' }))
    expect(await within(dialog).findByText('没做成')).toBeDefined()
    await user().click(within(dialog).getByRole('button', { name: '换令牌' }))
    expect(await screen().findByText(/已经写进 data 目录/)).toBeDefined()
  })
})
