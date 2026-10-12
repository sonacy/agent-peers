import '../helpers/dom'
import { describe, expect, it, mock } from 'bun:test'
import { EmptyState, NoAgentsEmpty, NoAsksEmpty, NoRoomsEmpty } from '../../src/components/empty-state'
import { ErrorBanner, HubErrorBanner, StaleData } from '../../src/components/error-banner'
import { ReachabilityHint, WarnBox } from '../../src/components/reachability-hint'
import { RelativeTime } from '../../src/components/relative-time'
import { TruncatedText } from '../../src/components/truncated-text'
import { isOverflowing } from '../../src/lib/hooks/use-overflow'
import { Providers } from '../../src/providers'
import { renderUi, screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

describe('empty states (§5)', () => {
  it('no agents: sleeping face and the command', () => {
    const { container } = renderUi(<NoAgentsEmpty />)
    expect(screen().getByRole('region', { name: '还没有 agent 进房间' })).toBeDefined()
    expect(screen().getByText('/peers:room new 名字').tagName).toBe('CODE')
    expect(container.querySelector('[data-expression="offline"]')).not.toBeNull()
  })
  it('no rooms: create and find actions', async () => {
    const onCreate = mock(() => {})
    const onFind = mock(() => {})
    renderUi(<NoRoomsEmpty onCreate={onCreate} onFind={onFind} />)
    expect(screen().getByText('自己开一个，或者找同事的房间敲门。')).toBeDefined()
    const u = user()
    await u.click(screen().getByRole('button', { name: '新建房间' }))
    await u.click(screen().getByRole('button', { name: '找房间' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onFind).toHaveBeenCalledTimes(1)
  })
  it('no asks: two faces', () => {
    const { container } = renderUi(<NoAsksEmpty />)
    expect(screen().getByRole('heading', { name: '它们还没说过话' })).toBeDefined()
    expect(container.querySelectorAll('[data-face-color]')).toHaveLength(2)
  })
  it('generic empty state without art or actions', () => {
    const { container } = renderUi(<EmptyState title="空" />)
    expect(container.querySelector('p')).toBeNull()
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})

describe('error states (§5)', () => {
  it('hub banner says when it retries and retries now', async () => {
    const onRetry = mock(() => {})
    const { container } = renderUi(
      <HubErrorBanner host="localhost:7300" retryInSeconds={12} onRetry={onRetry} />,
    )
    expect(container.textContent).toContain('连不上 Core（localhost:7300），12 秒后重试')
    expect(screen().getByText('（上次的数据，等 Core…）')).toBeDefined()
    expect(container.textContent).toContain('连上 Core 后再改')
    await user().click(screen().getByRole('button', { name: '现在重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
  it('keeps the live region fixed while the countdown ticks', () => {
    const { container, rerender } = renderUi(
      <HubErrorBanner host="localhost:7300" retryInSeconds={12} onRetry={() => {}} />,
    )
    const alert = screen().getByRole('alert')
    expect(alert.textContent).toBe('连不上 Core（localhost:7300）')
    for (const n of [11, 10, 0]) {
      rerender(
        <Providers>
          <HubErrorBanner host="localhost:7300" retryInSeconds={n} onRetry={() => {}} />
        </Providers>,
      )
      expect(screen().getByRole('alert') === alert).toBe(true)
      expect(alert.textContent).toBe('连不上 Core（localhost:7300）')
    }
    expect(alert.contains(container.querySelector('[data-ticker]'))).toBe(false)
  })
  it('says it is retrying at zero seconds', () => {
    const { container } = renderUi(<HubErrorBanner host="h" retryInSeconds={0} onRetry={() => {}} />)
    expect(container.textContent).toContain('连不上 Core（h），正在重试…')
  })
  it('generic banner with a description and no action', () => {
    renderUi(<ErrorBanner title="出错了" description="稍后再试" />)
    expect(screen().getByText('稍后再试')).toBeDefined()
    expect(screen().queryByRole('button')).toBeNull()
  })
  it('stale data is dimmed, inert and explains why it cannot be changed', () => {
    const { container, rerender } = renderUi(
      <StaleData stale>
        <button type="button">接受提问</button>
      </StaleData>,
    )
    const wrapper = container.querySelector('[aria-busy="true"]')
    expect(wrapper?.getAttribute('title')).toBe('连上 Core 后再改')
    expect(wrapper?.querySelector('[inert]')).not.toBeNull()
    rerender(
      <StaleData stale={false}>
        <button type="button">接受提问</button>
      </StaleData>,
    )
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(container.querySelector('[inert]')).toBeNull()
  })
  it('keeps the same elements (and their state) when going stale and back', () => {
    const { container, rerender } = renderUi(
      <StaleData stale={false}>
        <input aria-label="找房间" defaultValue="" />
      </StaleData>,
    )
    const input = screen().getByRole('textbox', { name: '找房间' }) as HTMLInputElement
    input.value = '支付'
    rerender(
      <Providers>
        <StaleData stale>
          <input aria-label="找房间" defaultValue="" />
        </StaleData>
      </Providers>,
    )
    expect(container.querySelector('[inert]')?.contains(input)).toBe(true)
    rerender(
      <Providers>
        <StaleData stale={false}>
          <input aria-label="找房间" defaultValue="" />
        </StaleData>
      </Providers>,
    )
    expect(screen().getByRole('textbox', { name: '找房间' }) === input).toBe(true)
    expect(input.value).toBe('支付')
  })
})

describe('RelativeTime', () => {
  const now = new Date(2026, 9, 12, 20, 0).getTime()
  it('renders relative text with a machine-readable time', () => {
    const ts = new Date(2026, 9, 12, 18, 9).getTime()
    renderUi(<RelativeTime ts={ts} now={now} />)
    const el = screen().getByText('今天 18:09')
    expect(el.tagName).toBe('TIME')
    // Screen readers hear the full time without the tooltip.
    expect(el.textContent).toBe('今天 18:09（2026 年 10 月 12 日 18:09:00）')
    expect(el.getAttribute('datetime')).toBe(new Date(ts).toISOString())
  })
  it('renders the ago form and ticks without a fixed now', () => {
    renderUi(<RelativeTime ts={now - 25_000} now={now} mode="ago" />)
    expect(screen().getByText('25 秒前')).toBeDefined()
    renderUi(<RelativeTime ts={Date.now()} />)
    expect(screen().getByText('刚刚')).toBeDefined()
  })
  it('shows the full timestamp in a tooltip', async () => {
    renderUi(
      <button type="button">
        <RelativeTime ts={new Date(2026, 9, 3, 18, 9, 5).getTime()} now={now} />
      </button>,
    )
    await user().hover(screen().getByText('10 月 3 日'))
    await waitFor(() =>
      expect(screen().getAllByText('2026 年 10 月 3 日 18:09:05').length).toBeGreaterThan(0),
    )
  })
})

describe('TruncatedText', () => {
  it('clamps with the full text in the title', () => {
    renderUi(<TruncatedText text="很长的标题" lines={2} />)
    const el = screen().getByText('很长的标题')
    expect(el.getAttribute('title')).toBe('很长的标题')
    expect(el.className).toContain('line-clamp-2')
  })
  it('truncates in the middle with an accessible full name', () => {
    renderUi(<TruncatedText text="a.very.long.username.example" middle={12} as="strong" />)
    const el = screen().getByText('a.very…ample')
    expect(el.tagName).toBe('STRONG')
    expect(el.getAttribute('aria-label')).toBe('a.very.long.username.example')
  })
  it('uses a tooltip when asked', async () => {
    renderUi(<TruncatedText text="claude-opus-4-5" tooltip />)
    const el = screen().getByText('claude-opus-4-5')
    expect(el.getAttribute('title')).toBeNull()
    expect(el.className).toContain('truncate')
    // Not clipped: no extra tab stop.
    expect(el.getAttribute('tabindex')).toBeNull()
  })
  it('makes clipped text focusable so the tooltip opens from the keyboard', async () => {
    renderUi(<TruncatedText text="a.very.long.username.example" middle={12} tooltip />)
    const el = screen().getByText('a.very…ample')
    expect(el.getAttribute('tabindex')).toBe('0')
    await user().tab()
    expect(document.activeElement).toBe(el)
    await waitFor(() =>
      expect(screen().getAllByText('a.very.long.username.example').length).toBeGreaterThan(0),
    )
  })
  it('opens and closes the tooltip with a tap (touch screens never hover)', async () => {
    renderUi(<TruncatedText text="claude-opus-4-5-20251101-thinking" tooltip />)
    const el = screen().getByText('claude-opus-4-5-20251101-thinking')
    await user().click(el)
    await waitFor(() => expect(screen().getByRole('tooltip')).toBeDefined())
    await user().click(el)
    await waitFor(() => expect(screen().queryByRole('tooltip')).toBeNull())
  })
  it('measures CSS clipping', () => {
    const box = { scrollWidth: 100, clientWidth: 100, scrollHeight: 20, clientHeight: 20 }
    expect(isOverflowing(box)).toBe(false)
    expect(isOverflowing({ ...box, scrollWidth: 140 })).toBe(true)
    expect(isOverflowing({ ...box, scrollHeight: 44 })).toBe(true)
  })
})

describe('ReachabilityHint (§6)', () => {
  it('renders nothing for push agents', () => {
    const { container } = renderUi(
      <ReachabilityHint card={{ agent: { kind: 'claude-code' }, inject: 'push', accepting: true }} />,
    )
    expect(container.textContent).toBe('')
  })
  it('renders the boundary copy in a warn box', () => {
    const { container } = renderUi(
      <ReachabilityHint card={{ agent: { kind: 'cursor' }, inject: 'boundary', accepting: true }} />,
    )
    expect(container.textContent).toContain('Cursor 一轮结束后 60 分钟内能被问到')
    expect(container.querySelector('p')?.className).toContain('bg-warn')
  })
  it('warn box takes a custom icon', () => {
    const { container } = renderUi(<WarnBox icon={<i data-testid="icon" />}>注意</WarnBox>)
    expect(screen().getByTestId('icon')).toBeDefined()
    expect(container.textContent).toBe('注意')
  })
})
