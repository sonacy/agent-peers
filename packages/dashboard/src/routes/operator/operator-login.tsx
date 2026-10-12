/**
 * Operator sign-in (DASHBOARD §10): the admin token is exchanged for an HttpOnly cookie by
 * `POST /v0/admin/login`. The token is typed (or pasted) here once and never stored by the page.
 */
import { KeyRound } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { ErrorBanner } from '../../components/error-banner'
import { PeersLogo } from '../../components/peers-logo'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Chip } from '../../components/ui/chip'
import { InlineCode, Input } from '../../components/ui/input'
import { useAdminLogin } from './admin-queries'
import { adminErrorText } from './format'

export function OperatorLogin() {
  const login = useAdminLogin()
  const [token, setToken] = useState('')
  const inputId = useId()
  const hintId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    if (value !== '') login.mutate(value, { onSuccess: () => setToken('') })
  }
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="flex w-full max-w-md flex-col gap-5 p-6">
        <div className="flex items-center justify-between gap-3">
          <PeersLogo />
          <Chip tone="ink">运维</Chip>
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display font-extrabold text-section">登录 Core 运维</h1>
          <p id={hintId} className="text-muted text-sm">
            用管理令牌登录。hub 第一次启动时会打印它，也存在 data 目录的 <InlineCode>admin-token</InlineCode>{' '}
            文件里。这个页面只在 hub 这台机器上能打开。
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="font-semibold text-sm">
              管理令牌
            </label>
            <div className="relative">
              <KeyRound
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              />
              <Input
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={hintId}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className="pl-9 font-mono"
              />
            </div>
          </div>
          {login.isError ? <ErrorBanner title="没登录上" description={adminErrorText(login.error)} /> : null}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            disabled={login.isPending || token.trim() === ''}
          >
            {login.isPending ? '正在登录…' : '登录'}
          </Button>
        </form>
      </Card>
    </main>
  )
}
