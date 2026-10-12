import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { act, render, within } from '@testing-library/react'
import { CreateRoomDialog } from '../../src/components/rooms/create-room-dialog'
import { ConfirmDialog, DissolveDialog } from '../../src/components/rooms/detail/confirm-dialogs'
import { LiveProvider } from '../../src/live/live-provider'
import { Providers } from '../../src/providers'
import { memberHub, renderApp } from '../helpers/app'
import { apiError, createFakeSource, FakeEventSource } from '../helpers/fake-hub'
import { card, ME } from '../helpers/fixtures'
import { screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

/** Two failures in a row: the pill turns red and the page goes stale (§7). */
async function disconnect(): Promise<void> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
  const before = FakeEventSource.instances.length
  act(() => FakeEventSource.latest().fail())
  await waitFor(() => expect(FakeEventSource.instances.length).toBe(before + 1), { timeout: 2500 })
  act(() => FakeEventSource.latest().fail())
}

function homeHub() {
  return memberHub({
    'GET /v0/me/sessions': {
      sessions: [card(), card({ session_id: 's_2', title: 'two', connection: 'offline' })],
    },
  })
}

describe('Core unreachable on first load', () => {
  it('starts the stream anyway, offers a retry for me, and recovers', async () => {
    let up = false
    const hub = memberHub({ 'GET /v0/me': () => (up ? ME : apiError('internal', 500, 'down')) })
    renderApp('/app/', hub)
    // The stream doesn't wait for `me`: its backoff is what brings the page back.
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    expect(await screen().findByText('没拿到你的账号信息', {}, { timeout: 4000 })).toBeDefined()
    up = true
    await user().click(screen().getByRole('button', { name: '重试' }))
    expect(await screen().findByRole('button', { name: '账户菜单（gulei）' })).toBeDefined()
    expect(screen().queryByText('没拿到你的账号信息')).toBeNull()
    act(() => FakeEventSource.latest().open())
    expect(screen().getByText('Core 已连接')).toBeDefined()
  })
  it('refetches everything, me included, once the stream comes back', async () => {
    let up = false
    const hub = memberHub({ 'GET /v0/me': () => (up ? ME : apiError('internal', 500, 'down')) })
    renderApp('/app/', hub)
    await disconnect()
    expect(await screen().findByRole('button', { name: '现在重试' })).toBeDefined()
    up = true
    await user().click(screen().getByRole('button', { name: '现在重试' }))
    act(() => FakeEventSource.latest().open())
    expect(await screen().findByRole('button', { name: '账户菜单（gulei）' })).toBeDefined()
  })
})

describe('an expired session looks like a dead hub to EventSource', () => {
  it('re-checks me on a stream failure and signs out on a 401', async () => {
    let expired = false
    const hub = memberHub({ 'GET /v0/me': () => (expired ? apiError('unauthorized', 401) : ME) })
    renderApp('/app/', hub)
    await screen().findByRole('button', { name: '账户菜单（gulei）' })
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    expired = true
    act(() => FakeEventSource.latest().fail())
    expect(await screen().findByRole('heading', { name: '还没登录' }, { timeout: 3000 })).toBeDefined()
    expect(location.pathname).toBe('/app/login')
  })
})

describe('stale data keeps the page', () => {
  it('keeps a selected filter through a disconnect and a reconnect', async () => {
    renderApp('/app/', homeHub())
    await screen().findByRole('article', { name: 'two' })
    await user().click(screen().getByRole('button', { name: '离线 1' }))
    const offline = () => screen().getByRole('button', { name: '离线 1' })
    expect(offline().getAttribute('aria-pressed')).toBe('true')
    await disconnect()
    expect(screen().getByText('连不上 Core')).toBeDefined()
    expect(offline().closest('[inert]')).not.toBeNull()
    expect(offline().getAttribute('aria-pressed')).toBe('true')
    await user().click(screen().getByRole('button', { name: '现在重试' }))
    act(() => FakeEventSource.latest().open())
    expect(screen().getByText('Core 已连接')).toBeDefined()
    expect(offline().closest('[inert]')).toBeNull()
    expect(offline().getAttribute('aria-pressed')).toBe('true')
    expect(screen().queryByRole('article', { name: '通用插件跨 agent session 同步' })).toBeNull()
  })
  it('holds back the top bar + while stale', async () => {
    renderApp('/app/', homeHub())
    await screen().findByRole('article', { name: 'two' })
    const plus = () =>
      within(screen().getAllByRole('banner')[0] as HTMLElement).getByRole('link', { name: '新建房间' })
    expect(plus().getAttribute('aria-disabled')).toBeNull()
    await disconnect()
    expect(plus().getAttribute('aria-disabled')).toBe('true')
    await user().click(plus())
    expect(location.search).not.toContain('new=1')
  })
})

describe('dialogs portaled outside the stale page', () => {
  it('disable their submit with 连上 Core 后再改 while Core is unreachable', async () => {
    FakeEventSource.reset()
    const noop = () => {}
    render(
      <Providers createEventSource={createFakeSource}>
        <LiveProvider enabled>
          <ConfirmDialog
            open
            onOpenChange={noop}
            onConfirm={noop}
            title="全部开门"
            description="d"
            confirmLabel="开门"
          />
          <DissolveDialog open onOpenChange={noop} onConfirm={noop} roomName="timely" />
          <CreateRoomDialog open onOpenChange={noop} onCreated={noop} />
        </LiveProvider>
      </Providers>,
    )
    expect(screen().queryAllByText('连上 Core 后再改')).toHaveLength(0)
    await disconnect()
    const hidden = { hidden: true }
    await waitFor(() => expect(screen().queryAllByText('连上 Core 后再改')).toHaveLength(3))
    const disabled = (name: string) =>
      (screen().getByRole('button', { name, ...hidden }) as HTMLButtonElement).disabled
    expect(disabled('开门')).toBe(true)
    expect(disabled('解散房间')).toBe(true)
    expect(disabled('建好了，去发邀请')).toBe(true)
  })
})
