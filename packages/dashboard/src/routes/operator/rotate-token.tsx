/**
 * Rotate the admin token (DASHBOARD §10). The new token is shown once, with a copy button; this
 * browser stays signed in, every other operator browser and script using the old token is cut off.
 */
import { Copy, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { useToast } from '../../components/ui/toast'
import { useRotateToken } from './admin-queries'
import type { RotateResult } from './admin-schemas'
import { ConfirmDialog } from './confirm-dialog'
import { adminErrorText } from './format'
import { copyText } from './logic'

function NewTokenDialog({
  result,
  onClose,
}: {
  readonly result: RotateResult | undefined
  readonly onClose: () => void
}) {
  const { toast } = useToast()
  const copy = async () => {
    if (result === undefined) return
    const ok = await copyText(result.admin_token)
    toast(
      ok
        ? { title: '已复制新令牌', tone: 'success' }
        : { title: '没复制上', description: '浏览器不让写剪贴板，手动选中令牌复制。', tone: 'danger' },
    )
  }
  return (
    <Dialog open={result !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新的管理令牌</DialogTitle>
          <DialogDescription>
            {result?.persisted
              ? '已经写进 data 目录的 admin-token 文件。只显示这一次，需要的话现在复制。'
              : '这个 hub 没有 data 目录（内存模式），令牌没存到文件里。只显示这一次，现在复制保存好。'}
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-xl border-2 border-line bg-ink-fill p-3 font-mono text-on-ink text-sm">
          <code>{result?.admin_token}</code>
        </pre>
        <DialogFooter>
          <DialogClose asChild>
            <Button>好了</Button>
          </DialogClose>
          <Button variant="primary" onClick={() => void copy()}>
            <Copy aria-hidden="true" />
            复制令牌
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RotateTokenSection() {
  const rotate = useRotateToken()
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<RotateResult | undefined>(undefined)
  const confirm = () =>
    rotate.mutate(undefined, {
      onSuccess: (next) => {
        setConfirming(false)
        setResult(next)
      },
    })
  return (
    <Card className="flex flex-col gap-3 p-5" role="region" aria-labelledby="rotate-title">
      <div className="flex items-center gap-2">
        <KeyRound aria-hidden="true" className="size-5" />
        <h2 id="rotate-title" className="font-display font-bold text-section">
          管理令牌
        </h2>
      </div>
      <p className="text-muted text-sm">
        怀疑令牌泄露了，就换一个。旧令牌马上失效，用它的脚本和其他浏览器都要用新令牌重新登录。
      </p>
      <Button variant="danger-outline" onClick={() => setConfirming(true)}>
        换一个管理令牌…
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) rotate.reset()
          setConfirming(open)
        }}
        title="换一个管理令牌？"
        description="旧令牌立即失效。这个浏览器会保持登录，新令牌只显示一次。"
        actionLabel="换令牌"
        pending={rotate.isPending}
        error={rotate.isError ? adminErrorText(rotate.error) : undefined}
        onConfirm={confirm}
      />
      <NewTokenDialog result={result} onClose={() => setResult(undefined)} />
    </Card>
  )
}
