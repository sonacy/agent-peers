import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { within } from '@testing-library/react'
import { memberHub, renderApp } from '../helpers/app'
import { apiError } from '../helpers/fake-hub'
import { card, myRoom, thread } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

const LONG = `${Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行：回调失败后进入重试队列`).join('\n')}\n\`\`\`\nretry_delays_min = [1, 2, 4, 8, 16, 32, 64]\n\`\`\`\nhttps://code.example.com/payment/refund-center/docs`

const THREADS = [
  thread({ id: 'a_answered', question: 'T3 Code 有多少用户？', answer: '工作台本身不收费' }),
  thread({ id: 'a_working', state: 'working', answer: null }),
  thread({ id: 'a_queued', state: 'queued', answer: null }),
  thread({ id: 'a_delivered', state: 'delivered', answer: null }),
  thread({ id: 'a_declined', state: 'declined', answer: '我这边没有权限看支付仓库' }),
  thread({ id: 'a_failed', state: 'failed', reason: 'not_in_room', answer: null }),
  thread({ id: 'a_expired', state: 'expired', answer: null, from: null, to: null }),
  thread({ id: 'a_cancelled', state: 'cancelled', answer: null }),
  thread({ id: 'a_long', answer: LONG }),
  thread({ id: 'a_pending', state: 'answered', answer: null }),
]

function threadEl(id: string): HTMLElement {
  const el = document.querySelector(`[data-ask-id="${id}"]`)
  if (!(el instanceof HTMLElement)) throw new Error(`no thread ${id}`)
  return el
}

describe('问答', () => {
  it('renders every answer state', async () => {
    renderApp('/app/asks', memberHub({ 'GET /v0/me/asks': { asks: THREADS, next_cursor: null } }))
    expect(await screen().findByRole('heading', { name: '问答' })).toBeDefined()
    await screen().findByText('工作台本身不收费')
    expect(within(threadEl('a_answered')).getByText('已回答')).toBeDefined()
    expect(within(threadEl('a_answered')).getByText('timely')).toBeDefined()
    expect(within(threadEl('a_answered')).getByText('Recent popular agent projects · zhangwei')).toBeDefined()
    expect(threadEl('a_working').querySelector('[data-typing]')).not.toBeNull()
    expect(
      within(threadEl('a_working')).getByText('已送到，对方正在想，答完会自己回到你的对话'),
    ).toBeDefined()
    expect(within(threadEl('a_queued')).getByText('对方不在线，上线后会收到')).toBeDefined()
    expect(within(threadEl('a_delivered')).getByText('已送到，对方空下来就答')).toBeDefined()
    expect(
      within(threadEl('a_declined')).getByText('对方没接这个问题：我这边没有权限看支付仓库'),
    ).toBeDefined()
    expect(within(threadEl('a_failed')).getByText('⊘ 没答上：你们俩已经不在同一个房间了')).toBeDefined()
    expect(within(threadEl('a_expired')).getByText('⊘ 没答上：一天没人答，过期了')).toBeDefined()
    expect(within(threadEl('a_expired')).getByText('@sync')).toBeDefined()
    expect(within(threadEl('a_cancelled')).getByText('提问的一方撤回了这个问题')).toBeDefined()
    expect(within(threadEl('a_pending')).getByText('已经答了，答案马上到')).toBeDefined()
    expect(screen().getByText('已显示全部 10 条')).toBeDefined()
  })
  it('collapses long answers with code blocks and wrapped links', async () => {
    renderApp('/app/asks', memberHub({ 'GET /v0/me/asks': { asks: [THREADS[8]], next_cursor: null } }))
    const expand = await screen().findByRole('button', { name: '展开全文' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    const long = threadEl('a_long')
    expect(long.querySelector('pre')?.textContent).toContain('retry_delays_min')
    const link = within(long).getByRole('link', {
      name: 'https://code.example.com/payment/refund-center/docs',
    })
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    // Collapsed: nothing below the cut is reachable; the start is read as plain text.
    const clipped = document.getElementById(expand.getAttribute('aria-controls') ?? '')
    expect(clipped?.hasAttribute('inert')).toBe(true)
    expect(clipped?.contains(link)).toBe(true)
    expect(clipped?.contains(long.querySelector('pre'))).toBe(true)
    expect(long.querySelector('[data-preview]')?.textContent?.endsWith('…')).toBe(true)
    await user().click(expand)
    expect(within(long).getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true')
    expect(clipped?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(clipped)
    expect(long.querySelector('[data-preview]')).toBeNull()
  })
  it('filters with the segmented control and loads more pages', async () => {
    const hub = memberHub({
      'GET /v0/me/asks': (call: { path: string }) => {
        const params = new URLSearchParams(call.path.split('?')[1])
        if (params.get('filter') === 'to_me') return { asks: [], next_cursor: null }
        if (params.get('cursor') === 'p2')
          return { asks: [thread({ id: 'a_page2', question: '第二页的问题' })], next_cursor: null }
        return { asks: [thread({ id: 'a_page1', question: '第一页的问题' })], next_cursor: 'p2' }
      },
    })
    renderApp('/app/asks', hub)
    await screen().findByText('第一页的问题')
    const u = user()
    await u.click(screen().getByRole('button', { name: '加载更多' }))
    expect(await screen().findByText('第二页的问题')).toBeDefined()
    expect(screen().getByText('已显示全部 2 条')).toBeDefined()
    await u.click(screen().getByRole('radio', { name: '问我的' }))
    expect(await screen().findByText('它们还没说过话')).toBeDefined()
    await u.click(screen().getByRole('radio', { name: '我问的' }))
    await waitFor(() => expect(hub.calls.some((c) => c.path.includes('filter=mine'))).toBe(true))
  })
  it('shows an error with retry', async () => {
    const hub = memberHub({ 'GET /v0/me/asks': () => apiError('internal', 500) })
    renderApp('/app/asks', hub)
    expect(await screen().findByText('问答没加载出来', {}, { timeout: 3000 })).toBeDefined()
    hub.on('GET /v0/me/asks', { asks: [thread({ question: '恢复了' })], next_cursor: null })
    await user().click(screen().getByRole('button', { name: '重试' }))
    expect(await screen().findByText('恢复了')).toBeDefined()
  })
  it('labels other members on both sides', async () => {
    const other = card({ session_id: 's_li', member: 'lina', title: '账单服务排查' })
    renderApp(
      '/app/asks',
      memberHub({ 'GET /v0/me/asks': { asks: [thread({ id: 'a_o', from: other })], next_cursor: null } }),
    )
    expect(await screen().findByText('账单服务排查 · lina')).toBeDefined()
  })
  it('names the room by its display name and styles inline code in answers', async () => {
    const answer = '回调头里带 `X-Signature`，用 `payment.callback.pubkey` 验签。'
    renderApp(
      '/app/asks',
      memberHub({
        'GET /v0/me/rooms': { rooms: [myRoom({ id: 'r_timely', name: 'pay-integration' })] },
        'GET /v0/me/asks': { asks: [thread({ id: 'a_code', answer })], next_cursor: null },
      }),
    )
    const code = await screen().findByText('X-Signature')
    expect(code.tagName).toBe('CODE')
    expect(code.className).toContain('font-mono')
    expect(threadEl('a_code').textContent).not.toContain('`')
    expect(within(threadEl('a_code')).getByText('payment.callback.pubkey').tagName).toBe('CODE')
    await waitFor(() => expect(within(threadEl('a_code')).getByText('pay-integration')).toBeDefined())
  })
  it('prefers the room display name over the slug', async () => {
    const pay = myRoom({ id: 'r_timely', name: 'pay-integration' })
    renderApp(
      '/app/asks',
      memberHub({
        'GET /v0/me/rooms': { rooms: [{ ...pay, room: { ...pay.room, display_name: '支付联调' } }] },
        'GET /v0/me/asks': { asks: [thread({ id: 'a_pay' })], next_cursor: null },
      }),
    )
    await waitFor(() => expect(within(threadEl('a_pay')).getByText('支付联调')).toBeDefined())
    expect(within(threadEl('a_pay')).queryByText('timely')).toBeNull()
  })
})
