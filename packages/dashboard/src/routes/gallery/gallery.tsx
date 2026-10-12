/** `/app/_gallery`: every component in every state, for visual QA in both themes. */
import { Link } from 'wouter'
import { PeersLogo } from '../../components/peers-logo'
import { Segmented } from '../../components/ui/segmented'
import { Switch } from '../../components/ui/switch'
import { useMotionPreference } from '../../lib/motion-preference'
import { type Theme, useTheme } from '../../lib/theme'
import { ContentSection } from './sections/content'
import { ControlsSection } from './sections/controls'
import { FoundationsSection } from './sections/foundations'
import { IdentitySection } from './sections/identity'
import { OverlaysSection } from './sections/overlays'
import { StatesSection } from './sections/states'

const THEME_OPTIONS: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function GalleryToolbar() {
  const [theme, setTheme] = useTheme()
  const { appReduced, setAppReduced } = useMotionPreference()
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Segmented label="主题" value={theme} options={THEME_OPTIONS} onValueChange={setTheme} />
      <div className="flex items-center gap-3 text-sm">
        <label htmlFor="gallery-reduce-motion">减少动态效果</label>
        <Switch id="gallery-reduce-motion" checked={appReduced} onCheckedChange={setAppReduced} />
      </div>
    </div>
  )
}

export default function Gallery() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-4">
        <Link href="/" className="focus-ring w-fit rounded-lg" aria-label="回到首页">
          <PeersLogo />
        </Link>
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-page font-extrabold">组件画廊</h1>
          <p className="text-muted">每个组件的每种状态，用来对照设计稿做视觉检查。</p>
        </div>
        <GalleryToolbar />
      </header>
      <FoundationsSection />
      <ControlsSection />
      <IdentitySection />
      <OverlaysSection />
      <StatesSection />
      <ContentSection />
    </main>
  )
}
