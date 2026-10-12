/**
 * The operator frame (DASHBOARD §10): logo with a 运维 chip, no member navigation, and a menu with
 * theme, 减少动态效果 and 退出. Member screens are not reachable from here.
 */
import { LogOut, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { ErrorBanner } from '../../components/error-banner'
import { PeersLogo } from '../../components/peers-logo'
import { Chip } from '../../components/ui/chip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { useMotionPreference } from '../../lib/motion-preference'
import { parseTheme, useTheme } from '../../lib/theme'
import { useAdminLogout } from './admin-queries'
import { adminErrorText } from './format'

function OperatorMenu({ logout }: { readonly logout: ReturnType<typeof useAdminLogout> }) {
  const [theme, setTheme] = useTheme()
  const { appReduced, setAppReduced } = useMotionPreference()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="运维菜单"
        className="focus-ring inline-flex size-11 cursor-pointer items-center justify-center rounded-xl border-2 border-line bg-surface shadow-btn"
      >
        <Settings2 aria-hidden="true" className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>主题</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(parseTheme(value))}>
          <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">浅色</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">深色</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={appReduced}
          onCheckedChange={(value) => setAppReduced(value === true)}
        >
          减少动态效果
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" onSelect={() => logout.mutate()} disabled={logout.isPending}>
          <LogOut aria-hidden="true" />
          退出运维
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function OperatorShell({ children }: { readonly children: ReactNode }) {
  const logout = useAdminLogout()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-line border-b-2 bg-bg">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <PeersLogo />
          <Chip tone="ink" size="md">
            Core 运维
          </Chip>
          <div className="ml-auto">
            <OperatorMenu logout={logout} />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6 sm:pt-8">
        {logout.isError ? (
          <ErrorBanner
            title="没退出成功，你还登录着"
            description={`${adminErrorText(logout.error)}运维登录还有效，稍后再退一次。`}
            actionLabel="再试一次"
            onAction={() => logout.mutate()}
          />
        ) : null}
        {children}
      </main>
    </div>
  )
}
