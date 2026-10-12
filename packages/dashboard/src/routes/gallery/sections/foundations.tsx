/** Tokens, type scale and shapes (DASHBOARD §3). */
import { Card } from '../../../components/ui/card'
import { GallerySection, Specimen } from '../kit'

const SWATCHES = [
  ['bg', 'bg-bg'],
  ['surface', 'bg-surface'],
  ['surface-2', 'bg-surface-2'],
  ['ink', 'bg-ink-fill'],
  ['muted', 'bg-muted'],
  ['primary', 'bg-primary'],
  ['primary-soft', 'bg-primary-soft'],
  ['lime', 'bg-lime'],
  ['warn', 'bg-warn'],
  ['danger', 'bg-danger'],
  ['ok', 'bg-ok'],
  ['busy', 'bg-busy'],
  ['face-violet', 'bg-face-violet'],
  ['face-sky', 'bg-face-sky'],
  ['face-butter', 'bg-face-butter'],
  ['face-mint', 'bg-face-mint'],
  ['face-blush', 'bg-face-blush'],
  ['face-cloud', 'bg-face-cloud'],
] as const

export function FoundationsSection() {
  return (
    <GallerySection id="foundations" title="基础：颜色、字体、形状">
      <Specimen label="颜色 tokens" wide>
        {SWATCHES.map(([name, cls]) => (
          <span key={name} className="flex w-24 flex-col items-center gap-1 text-meta">
            <span className={`h-12 w-full rounded-xl border-2 border-line ${cls}`} />
            <code className="font-mono text-[11px]">{name}</code>
          </span>
        ))}
      </Specimen>
      <Specimen label="字号" className="flex-col">
        <span className="font-display text-page font-extrabold">嗨，gulei 页面标题 34</span>
        <span className="font-display text-section font-bold">区块标题 20</span>
        <span className="text-card font-semibold">卡片标题 15/600</span>
        <span className="text-meta text-muted">辅助信息 12</span>
        <code className="font-mono text-sm">/peers:join timely</code>
      </Specimen>
      <Specimen label="卡片形状">
        <Card className="h-20 w-32" />
        <Card tone="ink" className="h-20 w-32" />
        <Card tone="lime" className="h-20 w-32" />
        <Card tone="violet" className="h-20 w-32" />
        <Card tone="blush" className="h-20 w-32" />
        <Card tone="muted" elevation="flat" className="h-20 w-32" />
      </Specimen>
    </GallerySection>
  )
}
