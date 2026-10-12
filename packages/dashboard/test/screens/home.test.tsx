import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { within } from '@testing-library/react'
import type { SessionCard } from '../../src/api/types'
import { HERO_DISMISSED_KEY } from '../../src/routes/home/onboarding-hero'
import { memberHub, renderApp } from '../helpers/app'
import { apiError } from '../helpers/fake-hub'
import { card, myRoom, thread } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

const CARDS = [
  card(),
  card({
    session_id: 's_cursor',
    agent: { kind: 'cursor' },
    title: 'Recent popular agent projects',
    inject: 'boundary',
    activity: 'busy',
    summary: '正在回答一个问题',
    model: 'claude-opus-4-5-20251101-thinking',
    rooms: [
      { room_id: 'r_timely', handle: 'pop' },
      { room_id: 'r_pay', handle: 'pop' },
      { room_id: 'r_3', handle: 'pop' },
      { room_id: 'r_4', handle: 'pop' },
    ],
  }),
  card({ session_id: 's_off', title: 'prd2demo', connection: 'offline', rooms: [] }),
  card({ session_id: 's_old', title: '', outdated: true, agent: { kind: 'codex', adapter: '0.3.2' } }),
]

const ROOMS = [myRoom(), myRoom({ id: 'r_pay', name: 'pay', role: 'member', pending_knocks: 3 })]

/** The hub's copy of my sessions: PATCH handlers store into it, like the real hub would. */
let stored: readonly SessionCard[] = CARDS

function store(next: SessionCard): SessionCard {
  stored = stored.map((c) => (c.session_id === next.session_id ? next : c))
  return next
}

function hub() {
  stored = CARDS
  return memberHub({
    'GET /v0/me/sessions': () => ({ sessions: stored }),
    'GET /v0/me/rooms': { rooms: ROOMS },
    'GET /v0/me/asks': {
      asks: [thread(), thread({ state: 'working', answer: null }), thread(), thread(), thread()],
      next_cursor: null,
    },
  })
}

function cardEl(name: string): HTMLElement {
  return screen().getByRole('article', { name })
}

describe('home: 我的 agent', () => {
  it('greets, counts and shows the onboarding hero until dismissed', async () => {
    localStorage.removeItem(HERO_DISMISSED_KEY)
    renderApp('/app/', hub())
    expect(await screen().findByRole('heading', { name: '嗨，gulei 👋' })).toBeDefined()
    expect(await screen().findByText('你有 4 个 agent，在 2 个房间里串门。')).toBeDefined()
    const create = screen().getAllByRole('link', { name: '新建房间' })
    expect(create.map((a: HTMLElement) => a.getAttribute('href'))).toEqual([
      '/app/rooms?new=1',
      '/app/rooms?new=1',
    ])
    expect(screen().getByRole('link', { name: '找房间' }).getAttribute('href')).toBe('/app/rooms?find=1')
    expect(screen().getByRole('heading', { name: '三步，让你的 agent 交到朋友' })).toBeDefined()
    await user().click(screen().getByRole('button', { name: '知道了' }))
    expect(screen().queryByRole('heading', { name: '三步，让你的 agent 交到朋友' })).toBeNull()
    expect(localStorage.getItem(HERO_DISMISSED_KEY)).toBe('true')
  })
  it('hides the hero once a room has two agents', async () => {
    localStorage.removeItem(HERO_DISMISSED_KEY)
    renderApp('/app/', memberHub({ 'GET /v0/me/rooms': { rooms: [myRoom({ agents: 2 })] } }))
    await screen().findByText('你有 0 个 agent，在 1 个房间里串门。')
    expect(screen().queryByRole('heading', { name: '三步，让你的 agent 交到朋友' })).toBeNull()
  })
  it('renders agent cards with status, hints, chips and room tags', async () => {
    renderApp('/app/', hub())
    const sync = await screen().findByRole('article', { name: '通用插件跨 agent session 同步' })
    expect(within(sync).getByText('Claude Code')).toBeDefined()
    expect(within(sync).getByText('有空')).toBeDefined()
    expect(within(sync).getByText('timely')).toBeDefined()
    const cursor = cardEl('Recent popular agent projects')
    expect(within(cursor).getByText('正在忙')).toBeDefined()
    expect(within(cursor).getByText('· 正在回答一个问题')).toBeDefined()
    expect(within(cursor).getByText(/Cursor 一轮结束后 60 分钟内能被问到/)).toBeDefined()
    expect(within(cursor).getByText('pay')).toBeDefined()
    expect(within(cursor).getByLabelText('还有 2 个房间').textContent).toBe('+2')
    expect(within(cardEl('prd2demo')).getByText('离线')).toBeDefined()
    const old = cardEl('Codex · mbp')
    expect(within(old).getByText(/Peers 插件是 0.3.2/)).toBeDefined()
    expect(within(old).getByRole('button', { name: '复制升级命令' })).toBeDefined()
  })
  it('filters by status with counts', async () => {
    renderApp('/app/', hub())
    await screen().findByRole('article', { name: 'prd2demo' })
    const u = user()
    expect(screen().getByRole('button', { name: '全部 4' }).getAttribute('aria-pressed')).toBe('true')
    await u.click(screen().getByRole('button', { name: '离线 1' }))
    expect(
      screen()
        .getAllByRole('article')
        .filter((a: HTMLElement) => a.dataset.sessionId),
    ).toHaveLength(1)
    await u.click(screen().getByRole('button', { name: '正在忙 1' }))
    expect(screen().getByRole('article', { name: 'Recent popular agent projects' })).toBeDefined()
    await u.click(screen().getByRole('button', { name: '有空 2' }))
    expect(screen().queryByRole('article', { name: 'prd2demo' })).toBeNull()
  })
  it('toggles accepting optimistically and rolls back with a toast on failure', async () => {
    const h = hub()
    let fail = false
    h.on('PATCH /v0/me/sessions/s_1', (call) => {
      if (fail) return apiError('forbidden', 403)
      return { session: store(card({ accepting: (call.body as { accepting: boolean }).accepting })) }
    })
    renderApp('/app/', h)
    const sync = await screen().findByRole('article', { name: '通用插件跨 agent session 同步' })
    const toggle = within(sync).getByRole('switch', { name: '接受提问' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const u = user()
    await u.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(h.callsTo('PATCH /v0/me/sessions/s_1')[0]?.body).toEqual({ accepting: false }))
    await waitFor(() => expect(within(sync).getByText('已暂停接受提问')).toBeDefined())
    fail = true
    await u.click(toggle)
    await waitFor(() =>
      expect(screen().getAllByText('这件事只有房主能做。想改的话找房主帮忙。').length).toBeGreaterThan(0),
    )
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
  it('renames title and handle from the card menu', async () => {
    const h = hub()
    h.on('PATCH /v0/me/sessions/s_cursor', (call) => {
      const base = CARDS[1] as SessionCard
      return { session: store({ ...base, title: (call.body as { title?: string }).title ?? base.title }) }
    })
    renderApp('/app/', h)
    await screen().findByRole('article', { name: 'Recent popular agent projects' })
    const u = user()
    await u.click(screen().getByRole('button', { name: 'Recent popular agent projects 的更多操作' }))
    await u.click(await screen().findByRole('menuitem', { name: '改名' }))
    const dialog = await screen().findByRole('dialog', { name: '改名' })
    const title = within(dialog).getByLabelText('标题')
    await u.clear(title)
    await u.type(title, '热门项目调研')
    await u.selectOptions(within(dialog).getByLabelText('在哪个房间改 @名字'), 'r_pay')
    const handle = within(dialog).getByLabelText(/@名字/, { selector: 'input' })
    await u.clear(handle)
    await u.type(handle, 'Bad Name')
    expect(within(dialog).getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
    await u.clear(handle)
    await u.type(handle, 'trends')
    await u.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(h.callsTo('PATCH /v0/me/sessions/s_cursor')[0]?.body).toEqual({
        title: '热门项目调研',
        handle: 'trends',
        room_id: 'r_pay',
      }),
    )
    expect(await screen().findByRole('article', { name: '热门项目调研' })).toBeDefined()
  })
  it('removes an agent from a room and pauses it from the menu', async () => {
    const h = hub()
    h.on('DELETE /v0/me/rooms/r_pay/sessions/s_cursor', { ok: true })
    h.on('PATCH /v0/me/sessions/s_cursor', { session: { ...CARDS[1], accepting: false } })
    renderApp('/app/', h)
    await screen().findByRole('article', { name: 'Recent popular agent projects' })
    const u = user()
    const menu = () => screen().getByRole('button', { name: 'Recent popular agent projects 的更多操作' })
    await u.click(menu())
    await u.click(await screen().findByRole('menuitem', { name: '移出房间…' }))
    const dialog = await screen().findByRole('dialog', { name: '移出房间' })
    await u.click(within(dialog).getByRole('radio', { name: /pay/ }))
    await u.click(within(dialog).getByRole('button', { name: '移出房间' }))
    await waitFor(() => expect(h.callsTo('DELETE /v0/me/rooms/r_pay/sessions/s_cursor')).toHaveLength(1))
    await u.click(menu())
    await u.click(await screen().findByRole('menuitem', { name: '暂停' }))
    await waitFor(() =>
      expect(h.callsTo('PATCH /v0/me/sessions/s_cursor')[0]?.body).toEqual({ accepting: false }),
    )
  })
  it('shows 刚刚聊过 with at most 4 compact threads and a link to 问答', async () => {
    renderApp('/app/', hub())
    const section = (await screen().findByRole('heading', { name: '刚刚聊过' })).closest(
      'section',
    ) as HTMLElement
    await waitFor(() => expect(within(section).getAllByRole('article')).toHaveLength(4))
    expect(within(section).getByRole('link', { name: '全部问答' }).getAttribute('href')).toBe('/app/asks')
    expect(within(section).getByText(/对方正在想/)).toBeDefined()
  })
  it('shows empty states for no agents and no asks', async () => {
    renderApp('/app/', memberHub())
    expect(await screen().findByText('还没有 agent 进房间')).toBeDefined()
    expect(await screen().findByText('它们还没说过话')).toBeDefined()
  })
  it('shows an error with retry when sessions fail', async () => {
    const h = memberHub({ 'GET /v0/me/sessions': () => apiError('internal', 500) })
    renderApp('/app/', h)
    expect(await screen().findByText('没拿到你的 agent 列表', {}, { timeout: 3000 })).toBeDefined()
    h.on('GET /v0/me/sessions', { sessions: [card()] })
    await user().click(screen().getByRole('button', { name: '重试' }))
    expect(await screen().findByRole('article', { name: '通用插件跨 agent session 同步' })).toBeDefined()
  })
  it('copies the upgrade command', async () => {
    renderApp('/app/', hub())
    const old = await screen().findByRole('article', { name: 'Codex · mbp' })
    await user().click(within(old).getByRole('button', { name: '复制升级命令' }))
    await waitFor(() => expect(screen().getAllByText(/已复制升级命令|没复制成/).length).toBeGreaterThan(0))
  })
})
