/** The avatar menu (DASHBOARD §2, §9): theme, 减少动态效果 and logout. */
import { LogOut } from 'lucide-react'
import { useLocation } from 'wouter'
import { friendlyError } from '../../api/errors'
import { useLogout } from '../../api/mutations'
import type { Me } from '../../api/types'
import { useMotionPreference } from '../../lib/motion-preference'
import { parseTheme, useTheme } from '../../lib/theme'
import { MemberAvatar } from '../member-avatar'
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
} from '../ui/dropdown-menu'
import { useToast } from '../ui/toast'

export function AccountMenu({ me }: { readonly me: Me | undefined }) {
  const [theme, setTheme] = useTheme()
  const { appReduced, setAppReduced } = useMotionPreference()
  const logout = useLogout()
  const [, navigate] = useLocation()
  const { toast } = useToast()
  const name = me?.name ?? '我'
  const signOut = () =>
    logout.mutate(undefined, {
      onSuccess: () => navigate('/login?signed_out=1'),
      onError: (error) =>
        toast({
          title: '没退出成功，你还登录着',
          description: `${friendlyError(error)}这台电脑上的登录还有效，稍后再退一次。`,
          tone: 'danger',
        }),
    })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`账户菜单（${name}）`}
        className="focus-ring inline-flex size-11 cursor-pointer items-center justify-center rounded-full"
      >
        <MemberAvatar
          memberId={me?.member_id ?? 'me'}
          name={name}
          size={44}
          decorative
          className="shadow-chip"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel className="font-semibold text-ink">{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
        <DropdownMenuItem tone="danger" onSelect={signOut} disabled={logout.isPending}>
          <LogOut aria-hidden="true" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
