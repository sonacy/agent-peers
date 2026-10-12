import './helpers/dom'
import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { App, modeFor } from '../src/app'
import { REDUCE_MOTION_KEY } from '../src/lib/motion-preference'
import { createQueryClient } from '../src/providers'
import { memberHub, renderApp } from './helpers/app'
import { screen, setupUi, user, waitFor } from './helpers/render'

setupUi()

function visit(path: string): void {
  window.history.replaceState(null, '', path)
}

describe('App routes', () => {
  it('shows the home screen at /app/', async () => {
    renderApp('/app/', memberHub())
    expect(await screen().findByRole('heading', { name: '嗨，gulei 👋' })).toBeDefined()
  })
  it('shows not found inside the shell for unknown routes', async () => {
    renderApp('/app/nowhere', memberHub())
    expect(await screen().findByText('这里什么都没有')).toBeDefined()
    expect(screen().getByRole('link', { name: '回到首页' }).getAttribute('href')).toBe('/app/')
  })
  it('routes /rooms?new=1 to the rooms screen with the create dialog open', async () => {
    renderApp('/app/rooms?new=1', memberHub())
    expect(await screen().findByRole('dialog', { name: '新建房间' })).toBeDefined()
  })
  it('routes /rooms/:id to the room detail screen', async () => {
    renderApp('/app/rooms/r_1', memberHub())
    expect(await screen().findByRole('heading', { name: '这个房间已经解散了' })).toBeDefined()
  })
  it('routes /rooms?find=1 to the rooms screen with search focused', async () => {
    renderApp('/app/rooms?find=1', memberHub())
    expect(await screen().findByRole('searchbox', { name: '找房间' })).toBeDefined()
  })
  it('renders the operator view under /admin', async () => {
    visit('/admin/')
    const original = globalThis.fetch
    const unauthorized = { error: { code: 'unauthorized', message: 'sign in' } }
    globalThis.fetch = Object.assign(async () => Response.json(unauthorized, { status: 401 }), {
      preconnect: original.preconnect,
    })
    try {
      render(<App mode="operator" base="/admin" client={createQueryClient()} />)
      expect(await screen().findByRole('heading', { name: '登录 Core 运维' })).toBeDefined()
    } finally {
      globalThis.fetch = original
    }
  })
  it('picks the app by path', () => {
    expect(modeFor('/admin')).toEqual({ mode: 'operator', base: '/admin' })
    expect(modeFor('/admin/rooms')).toEqual({ mode: 'operator', base: '/admin' })
    expect(modeFor('/app/')).toEqual({ mode: 'member', base: '/app' })
    expect(modeFor('/administrator')).toEqual({ mode: 'member', base: '/app' })
  })
  it('renders the gallery with every section, theme and motion switches', async () => {
    // Reduced motion keeps motion from starting Web Animations that happy-dom cancels on teardown.
    localStorage.setItem(REDUCE_MOTION_KEY, 'true')
    visit('/app/_gallery')
    render(<App />)
    expect(await screen().findByRole('heading', { name: '组件画廊' }, { timeout: 3000 })).toBeDefined()
    for (const title of [
      '基础：颜色、字体、形状',
      '按钮和控件',
      '小脸、头像、门',
      '浮层',
      '空、加载、出错',
      '数字、时间、长文本',
    ]) {
      expect(screen().getByRole('heading', { name: title })).toBeDefined()
    }
    const u = user()
    await u.click(screen().getByRole('radio', { name: '深色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    await u.click(screen().getByRole('radio', { name: '跟随系统' }))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
    await u.click(screen().getByRole('switch', { name: '减少动态效果' }))
    expect(document.documentElement.dataset.reduceMotion).toBe('false')
    await u.click(screen().getByRole('switch', { name: '减少动态效果' }))
    await u.click(screen().getByRole('button', { name: '加载完成' }))
    expect(screen().getByText('数据到了。')).toBeDefined()
    await u.click(screen().getAllByRole('button', { name: '复制邀请' })[0] as HTMLElement)
    await waitFor(() => expect(screen().getAllByText('已复制，粘到群里吧').length).toBeGreaterThan(0))
    await u.click(screen().getByRole('button', { name: '现在重试' }))
    await u.click(screen().getByRole('button', { name: '出错的 toast' }))
    await waitFor(() => expect(screen().getAllByText('没开成门').length).toBeGreaterThan(0))
    screen().getByRole('button', { name: '卡片菜单' }).focus()
    await u.keyboard('{Enter}')
    await u.click(await screen().findByRole('menuitemcheckbox', { name: '减少动态效果' }))
    expect(document.documentElement.dataset.reduceMotion).toBe('false')
    await u.click(screen().getByRole('button', { name: '有空 2' }))
    expect(screen().getByRole('button', { name: '有空 2' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('creates a query client without focus refetching', () => {
    const client = createQueryClient()
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })
})
