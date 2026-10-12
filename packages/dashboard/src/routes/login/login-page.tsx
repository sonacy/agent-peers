/**
 * Sign in (DASHBOARD §1): a 继续 (Continue) button only. The POST consumes the one-time code from
 * `?c=`; members never type a token. Without a code we explain how to get back here. The card sits
 * centered on the page under the Peers mark, styled like the other empty states.
 */
import { useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { friendlyError, isUnauthorized } from '../../api/errors'
import { useLogin } from '../../api/mutations'
import { AgentFace } from '../../components/agent-face'
import { ErrorBanner } from '../../components/error-banner'
import { PeersLogo } from '../../components/peers-logo'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { InlineCode } from '../../components/ui/input'

const MAX_CODE_CHARS = 128

/** The one-time code from `?c=` (or `?code=`), if it looks usable. */
export function loginCodeFrom(search: string): string | undefined {
  const params = new URLSearchParams(search)
  const code = params.get('c') ?? params.get('code') ?? ''
  return code === '' || code.length > MAX_CODE_CHARS ? undefined : code
}

function NoSession({ signedOut }: { readonly signedOut: boolean }) {
  return (
    <>
      <h1 className="font-display font-extrabold text-section">{signedOut ? '已退出登录' : '还没登录'}</h1>
      <p className="text-muted text-sm">
        打开你的 agent，输入 <InlineCode>/peers:dashboard</InlineCode>，会自动带你回来。
      </p>
    </>
  )
}

function expiredText(error: unknown): string {
  return isUnauthorized(error)
    ? '这个登录链接已经用过或过期了（5 分钟有效）。在 agent 里再输入一次 /peers:dashboard。'
    : friendlyError(error)
}

function Continue({ code }: { readonly code: string }) {
  const login = useLogin()
  const [, navigate] = useLocation()
  const [done, setDone] = useState(false)
  const submit = () =>
    login.mutate(code, {
      onSuccess: () => {
        setDone(true)
        navigate('/', { replace: true })
      },
    })
  return (
    <>
      <h1 className="font-display font-extrabold text-section">在这个浏览器里打开你的 Peers</h1>
      <p className="text-muted text-sm">点「继续」就登录好了，一次 7 天有效。</p>
      {login.isError ? <ErrorBanner title="没登录上" description={expiredText(login.error)} /> : null}
      <Button variant="primary" size="lg" block onClick={submit} disabled={login.isPending || done}>
        {login.isPending ? '正在登录…' : '继续'}
      </Button>
    </>
  )
}

export default function LoginPage() {
  const search = useSearch()
  const code = loginCodeFrom(search)
  const signedOut = new URLSearchParams(search).has('signed_out')
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <PeersLogo />
      <Card className="flex w-full max-w-sm flex-col items-center gap-4 p-6 text-center">
        <AgentFace id="login" size={64} expression={code === undefined ? 'offline' : 'idle'} />
        {code === undefined ? <NoSession signedOut={signedOut} /> : <Continue code={code} />}
      </Card>
    </main>
  )
}
