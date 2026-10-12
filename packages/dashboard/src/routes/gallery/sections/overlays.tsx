/** Dialog, sheet, tooltip, popover, menu, toast and scroll area. */
import { MoreHorizontal } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu'
import { Textarea } from '../../../components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { ScrollArea } from '../../../components/ui/scroll-area'
import {
  Sheet,
  SheetActions,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '../../../components/ui/sheet'
import { useToast } from '../../../components/ui/toast'
import { Tooltip } from '../../../components/ui/tooltip'
import { useMotionPreference } from '../../../lib/motion-preference'
import { GallerySection, Specimen } from '../kit'

function KnockDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="lime" size="sm">
          敲门申请
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>敲 timely 的门</DialogTitle>
          <DialogDescription>房主开门后，你的 agent 就能在房间里提问。</DialogDescription>
        </DialogHeader>
        <Textarea aria-label="留言（可选）" placeholder="想让我的 agent 问问 timely 里的接口规范" />
        <DialogFooter>
          <DialogClose asChild>
            <Button>取消</Button>
          </DialogClose>
          <Button variant="primary">敲门</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PersonSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="icon" aria-label="管理 li.na">
          <MoreHorizontal />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetTitle>管理 li.na</SheetTitle>
        <SheetDescription>他在这个房间有 7 个 agent。</SheetDescription>
        <SheetActions>
          <Button>把他的 agent 全部移出</Button>
          <Button variant="danger-outline">请出房间（之后不能再用邀请码进来）</Button>
          <SheetClose asChild>
            <Button variant="ghost" className="bg-surface-2">
              取消
            </Button>
          </SheetClose>
        </SheetActions>
      </SheetContent>
    </Sheet>
  )
}

function AvatarMenu() {
  const { appReduced, setAppReduced } = useMotionPreference()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" aria-label="卡片菜单">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>agent</DropdownMenuLabel>
        <DropdownMenuItem>改名</DropdownMenuItem>
        <DropdownMenuItem>移出房间…</DropdownMenuItem>
        <DropdownMenuItem>暂停</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={appReduced} onCheckedChange={(v) => setAppReduced(v === true)}>
          减少动态效果
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem tone="danger">退出登录</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ToastButtons() {
  const { toast } = useToast()
  return (
    <>
      <Button variant="primary" onClick={() => toast({ title: '已复制，粘到群里吧', tone: 'success' })}>
        复制邀请
      </Button>
      <Button onClick={() => toast({ title: '没开成门', description: '对方已经撤回了敲门', tone: 'danger' })}>
        出错的 toast
      </Button>
    </>
  )
}

export function OverlaysSection() {
  return (
    <GallerySection id="overlays" title="浮层">
      <Specimen label="Dialog（手机上变底部抽屉）">
        <KnockDialog />
      </Specimen>
      <Specimen label="Sheet">
        <PersonSheet />
      </Specimen>
      <Specimen label="Dropdown menu">
        <AvatarMenu />
      </Specimen>
      <Specimen label="Tooltip / Popover">
        <Tooltip content="claude-opus-4-5-20251101-preview">
          <Button size="sm">悬停看全名</Button>
        </Tooltip>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm">移出房间…</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p className="text-sm">选一个房间：timely、支付联调</p>
          </PopoverContent>
        </Popover>
      </Specimen>
      <Specimen label="Toast">
        <ToastButtons />
      </Specimen>
      <Specimen label="Scroll area">
        <ScrollArea
          className="h-32 w-full rounded-2xl border-2 border-line bg-surface"
          viewportLabel="敲门列表"
        >
          <ul className="flex flex-col gap-2 p-3 text-sm">
            {Array.from({ length: 12 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static specimen rows
              <li key={i}>敲门的人 #{i + 1}</li>
            ))}
          </ul>
        </ScrollArea>
      </Specimen>
    </GallerySection>
  )
}
