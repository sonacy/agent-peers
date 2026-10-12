import '../helpers/dom'
import { describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'
import { Badge } from '../../src/components/ui/badge'
import { Button } from '../../src/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../../src/components/ui/card'
import { Chip, FilterChip } from '../../src/components/ui/chip'
import { InlineCode, Input, SearchInput, Textarea } from '../../src/components/ui/input'
import { Segmented } from '../../src/components/ui/segmented'
import { CardSkeleton, DelayedSkeleton, Skeleton } from '../../src/components/ui/skeleton'
import { Switch } from '../../src/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../src/components/ui/tabs'
import { renderUi, screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

describe('Button', () => {
  it('defaults to a secondary type=button with a 44px target', () => {
    renderUi(<Button>找房间</Button>)
    const button = screen().getByRole('button', { name: '找房间' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).toContain('min-h-11')
    expect(button.className).toContain('press')
    expect(button.className).toContain('focus-ring')
  })
  it('renders each variant and size', () => {
    renderUi(
      <>
        <Button variant="primary">p</Button>
        <Button variant="lime" size="sm">
          l
        </Button>
        <Button variant="danger-outline" size="lg">
          d
        </Button>
        <Button variant="ghost" size="icon" aria-label="g" />
        <Button size="icon-sm" aria-label="i" block />
      </>,
    )
    expect(screen().getByRole('button', { name: 'p' }).className).toContain('bg-primary')
    expect(screen().getByRole('button', { name: 'l' }).className).toContain('bg-lime')
    expect(screen().getByRole('button', { name: 'd' }).className).toContain('text-danger')
    expect(screen().getByRole('button', { name: 'g' }).className).toContain('size-11')
    expect(screen().getByRole('button', { name: 'i' }).className).toContain('w-full')
  })
  it('renders a link with asChild and fires clicks', async () => {
    const onClick = mock(() => {})
    renderUi(
      <>
        <Button asChild variant="primary">
          <a href="/app/rooms">房间</a>
        </Button>
        <Button onClick={onClick} type="submit">
          go
        </Button>
      </>,
    )
    const link = screen().getByRole('link', { name: '房间' })
    expect(link.className).toContain('bg-primary')
    const submit = screen().getByRole('button', { name: 'go' })
    expect(submit.getAttribute('type')).toBe('submit')
    await user().click(submit)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Card', () => {
  it('has the outline and hard shadow by default, and tones', () => {
    const { container } = renderUi(
      <>
        <Card data-testid="a">
          <CardHeader>
            <CardTitle>timely</CardTitle>
          </CardHeader>
          <CardContent>body</CardContent>
          <CardFooter>接受提问</CardFooter>
        </Card>
        <Card data-testid="b" tone="ink" elevation="flat" />
      </>,
    )
    const a = screen().getByTestId('a')
    expect(a.className).toContain('border-2')
    expect(a.className).toContain('shadow-hard')
    expect(screen().getByTestId('b').className).toContain('bg-ink-fill')
    expect(screen().getByTestId('b').className).toContain('shadow-none')
    expect(container.querySelector('.divider-dotted')?.textContent).toBe('接受提问')
    expect(screen().getByRole('heading', { name: 'timely' })).toBeDefined()
  })
})

describe('Chip / FilterChip', () => {
  it('renders tones', () => {
    renderUi(<Chip tone="lime">房主</Chip>)
    expect(screen().getByText('房主').className).toContain('bg-lime')
  })
  it('exposes pressed state', async () => {
    function Row() {
      const [on, setOn] = useState(false)
      return (
        <FilterChip selected={on} onClick={() => setOn((v) => !v)}>
          有空 2
        </FilterChip>
      )
    }
    renderUi(<Row />)
    const chip = screen().getByRole('button', { name: '有空 2' })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    await user().click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.className).toContain('bg-active')
  })
})

describe('Badge', () => {
  it('caps at 99+ with an accessible label', () => {
    renderUi(<Badge count={128} label="128 人在敲门" />)
    expect(screen().getByText('99+')).toBeDefined()
    expect(screen().getByText('128 人在敲门').className).toContain('sr-only')
  })
  it('hides zero unless asked', () => {
    const { container } = renderUi(<Badge count={0} />)
    expect(container.textContent).toBe('')
    renderUi(<Badge count={0} hideZero={false} tone="ink" />)
    expect(screen().getAllByText('0').length).toBeGreaterThan(0)
  })
})

describe('Switch / Segmented / Tabs', () => {
  it('toggles a switch', async () => {
    const onChange = mock((_: boolean) => {})
    renderUi(<Switch aria-label="接受提问" defaultChecked onCheckedChange={onChange} />)
    const sw = screen().getByRole('switch', { name: '接受提问' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await user().click(sw)
    expect(onChange).toHaveBeenCalledWith(false)
  })
  it('selects a segment', async () => {
    const onChange = mock((_: string) => {})
    renderUi(
      <Segmented
        label="问答筛选"
        value="all"
        onValueChange={onChange}
        options={[
          { value: 'all', label: '全部' },
          { value: 'mine', label: '我问的' },
        ]}
      />,
    )
    expect(screen().getByRole('radiogroup', { name: '问答筛选' })).toBeDefined()
    await user().click(screen().getByText('我问的'))
    expect(onChange).toHaveBeenCalledWith('mine')
  })
  it('switches tabs', async () => {
    renderUi(
      <Tabs defaultValue="a">
        <TabsList aria-label="房间">
          <TabsTrigger value="a">成员</TabsTrigger>
          <TabsTrigger value="b">邀请</TabsTrigger>
        </TabsList>
        <TabsContent value="a">members</TabsContent>
        <TabsContent value="b">invite</TabsContent>
      </Tabs>,
    )
    expect(screen().getByText('members')).toBeDefined()
    const tab = screen().getByRole('tab', { name: '邀请' })
    await user().click(tab)
    await waitFor(() => expect(tab.getAttribute('data-state')).toBe('active'))
  })
})

describe('Inputs', () => {
  it('search box clears', async () => {
    function Box() {
      const [q, setQ] = useState('')
      return (
        <SearchInput label="找房间" placeholder="房间名或房主，比如 api" value={q} onValueChange={setQ} />
      )
    }
    renderUi(<Box />)
    const input = screen().getByRole('searchbox', { name: '找房间' }) as HTMLInputElement
    expect(screen().queryByRole('button', { name: '清空搜索' })).toBeNull()
    await user().type(input, 'api')
    expect(input.value).toBe('api')
    await user().click(screen().getByRole('button', { name: '清空搜索' }))
    expect(input.value).toBe('')
  })
  it('renders input, textarea and code', () => {
    renderUi(
      <>
        <Input aria-label="名字" />
        <Textarea aria-label="留言" />
        <InlineCode>/peers:ask</InlineCode>
      </>,
    )
    expect(screen().getByRole('textbox', { name: '名字' }).getAttribute('type')).toBe('text')
    expect(screen().getByRole('textbox', { name: '留言' }).tagName).toBe('TEXTAREA')
    expect(screen().getByText('/peers:ask').tagName).toBe('CODE')
  })
})

describe('Skeleton', () => {
  it('waits before showing, then shows children once loaded', async () => {
    function Load({ loading }: { loading: boolean }) {
      return (
        <DelayedSkeleton loading={loading} delayMs={30} fallback={<CardSkeleton />}>
          <p>loaded</p>
        </DelayedSkeleton>
      )
    }
    const { rerender } = renderUi(<Load loading />)
    expect(screen().queryByRole('status')).toBeNull()
    await waitFor(() => expect(screen().getByRole('status')).toBeDefined())
    expect(screen().getByText('加载中…')).toBeDefined()
    rerender(<Load loading={false} />)
    expect(screen().getByText('loaded')).toBeDefined()
  })
  it('renders a plain skeleton hidden from assistive tech', () => {
    const { container } = renderUi(<Skeleton className="h-3" />)
    expect(container.querySelector('[aria-hidden="true"]')?.className).toContain('animate-shimmer')
  })
})
