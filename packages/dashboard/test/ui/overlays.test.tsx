import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { Button } from '../../src/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  SrOnly,
} from '../../src/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../src/components/ui/dropdown-menu'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../src/components/ui/popover'
import { ScrollArea } from '../../src/components/ui/scroll-area'
import {
  Sheet,
  SheetActions,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '../../src/components/ui/sheet'
import { DANGER_TOAST_MS, DEFAULT_TOAST_MS, toastDuration, useToast } from '../../src/components/ui/toast'
import { Tooltip } from '../../src/components/ui/tooltip'
import { renderUi, screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

describe('Dialog', () => {
  it('opens, labels itself and closes with Escape and the close button', async () => {
    renderUi(
      <Dialog>
        <DialogTrigger asChild>
          <Button>敲门申请</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>敲 timely 的门</DialogTitle>
            <DialogDescription>
              房主开门后就能提问<SrOnly>。</SrOnly>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button>取消</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )
    const u = user()
    await u.click(screen().getByRole('button', { name: '敲门申请' }))
    const dialog = await screen().findByRole('dialog', { name: '敲 timely 的门' })
    expect(dialog.className).toContain('animate-sheet-up')
    expect(dialog.className).toContain('sm:animate-pop-in')
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
    await u.click(screen().getByRole('button', { name: '敲门申请' }))
    await u.click(await screen().findByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
  })
  it('can hide the corner close button', async () => {
    renderUi(
      <Dialog defaultOpen>
        <DialogContent hideClose>
          <DialogTitle>t</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    await screen().findByRole('dialog')
    expect(screen().queryByRole('button', { name: '关闭' })).toBeNull()
  })
})

describe('Sheet', () => {
  it('opens a bottom sheet with full-width actions', async () => {
    renderUi(
      <Sheet>
        <SheetTrigger asChild>
          <Button aria-label="管理 li.na">⋯</Button>
        </SheetTrigger>
        <SheetContent>
          <SheetTitle>管理 li.na</SheetTitle>
          <SheetDescription>7 个 agent</SheetDescription>
          <SheetActions>
            <Button variant="danger-outline">请出房间</Button>
            <SheetClose asChild>
              <Button>取消</Button>
            </SheetClose>
          </SheetActions>
        </SheetContent>
      </Sheet>,
    )
    const u = user()
    await u.click(screen().getByRole('button', { name: '管理 li.na' }))
    const sheet = await screen().findByRole('dialog', { name: '管理 li.na' })
    expect(sheet.className).toContain('bottom-0')
    await u.click(screen().getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen().queryByRole('dialog')).toBeNull())
  })
})

describe('Tooltip / Popover / HoverCard', () => {
  it('shows a tooltip on focus', async () => {
    renderUi(
      <Tooltip content="claude-opus-4-5-full-name">
        <button type="button">model</button>
      </Tooltip>,
    )
    await user().tab()
    await waitFor(() => expect(screen().getAllByText('claude-opus-4-5-full-name').length).toBeGreaterThan(0))
  })
  it('opens a popover on click', async () => {
    renderUi(
      <Popover>
        <PopoverTrigger asChild>
          <Button>移出房间…</Button>
        </PopoverTrigger>
        <PopoverContent>pick a room</PopoverContent>
      </Popover>,
    )
    await user().click(screen().getByRole('button', { name: '移出房间…' }))
    expect(await screen().findByText('pick a room')).toBeDefined()
  })
  it('renders hover card content when open', async () => {
    renderUi(
      <HoverCard defaultOpen>
        <HoverCardTrigger asChild>
          <a href="#x">core</a>
        </HoverCardTrigger>
        <HoverCardContent>details</HoverCardContent>
      </HoverCard>,
    )
    expect(await screen().findByText('details')).toBeDefined()
  })
})

describe('DropdownMenu', () => {
  it('opens from the keyboard and selects items', async () => {
    const picked: string[] = []
    renderUi(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="卡片菜单">⋯</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>agent</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => picked.push('rename')}>改名</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked>减少动态效果</DropdownMenuCheckboxItem>
          <DropdownMenuItem tone="danger">退出</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    const u = user()
    screen().getByRole('button', { name: '卡片菜单' }).focus()
    await u.keyboard('{Enter}')
    const item = await screen().findByRole('menuitem', { name: '改名' })
    expect(
      screen().getByRole('menuitemcheckbox', { name: '减少动态效果' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen().getByRole('menuitem', { name: '退出' }).className).toContain('text-danger')
    await u.click(item)
    expect(picked).toEqual(['rename'])
  })
})

describe('Toast', () => {
  function Trigger() {
    const { toast } = useToast()
    return (
      <Button
        onClick={() => toast({ title: '已复制，粘到群里吧', description: '去群里粘贴', tone: 'success' })}
      >
        复制邀请
      </Button>
    )
  }
  it('shows and dismisses a toast', async () => {
    renderUi(<Trigger />)
    const u = user()
    await u.click(screen().getByRole('button', { name: '复制邀请' }))
    expect((await screen().findAllByText('已复制，粘到群里吧')).length).toBeGreaterThan(0)
    expect(screen().getAllByText('去群里粘贴').length).toBeGreaterThan(0)
    await u.click(screen().getByRole('button', { name: '关闭通知' }))
    await waitFor(() => expect(screen().queryByRole('button', { name: '关闭通知' })).toBeNull())
  })
  it('keeps danger toasts up long enough to read the why and the next step', () => {
    expect(toastDuration({ tone: 'danger' })).toBe(DANGER_TOAST_MS)
    expect(DANGER_TOAST_MS).toBeGreaterThanOrEqual(8000)
    expect(toastDuration({ tone: 'success' })).toBe(DEFAULT_TOAST_MS)
    expect(toastDuration({})).toBe(DEFAULT_TOAST_MS)
    expect(toastDuration({ tone: 'danger', durationMs: 500 })).toBe(500)
  })
  it('requires the provider', () => {
    const original = console.error
    console.error = () => {}
    try {
      expect(() => render(<Trigger />)).toThrow('useToast must be used inside <ToastProvider>')
    } finally {
      console.error = original
    }
  })
})

describe('ScrollArea', () => {
  it('labels a focusable viewport', () => {
    renderUi(
      <ScrollArea viewportLabel="敲门列表" orientation="horizontal">
        <p>row</p>
      </ScrollArea>,
    )
    expect(screen().getByLabelText('敲门列表').getAttribute('tabindex')).toBe('0')
    renderUi(
      <ScrollArea>
        <p>plain</p>
      </ScrollArea>,
    )
    expect(screen().getByText('plain')).toBeDefined()
  })
})
