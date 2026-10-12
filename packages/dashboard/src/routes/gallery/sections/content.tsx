/** Formatting, hints and long text (DASHBOARD §6, §8). */
import { CircleAlert } from 'lucide-react'
import { motion } from 'motion/react'
import { AgentFace } from '../../../components/agent-face'
import { ReachabilityHint, WarnBox } from '../../../components/reachability-hint'
import { RelativeTime } from '../../../components/relative-time'
import { TruncatedText } from '../../../components/truncated-text'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { Chip } from '../../../components/ui/chip'
import { boundaryReminderText, outdatedPluginText } from '../../../lib/agent'
import { formatCount } from '../../../lib/format/count'
import { failReasonText } from '../../../lib/format/reasons'
import { entrance } from '../../../lib/motion'
import { useMotionPreference } from '../../../lib/motion-preference'
import { GALLERY_NOW, GallerySection, Specimen } from '../kit'

const MIN = 60_000
const TIMES: readonly (readonly [string, number])[] = [
  ['40 秒前', GALLERY_NOW - 40_000],
  ['12 分钟前', GALLERY_NOW - 12 * MIN],
  ['今天 18:09', new Date(2026, 9, 12, 18, 9).getTime()],
  ['今年 10 月 3 日', new Date(2026, 9, 3, 9, 30).getTime()],
  ['去年', new Date(2025, 11, 3, 9, 30).getTime()],
]

const LONG_TITLE =
  '帮我把 apps/plugin/src/adapters 下面 Cursor 适配器的 stop hook 长等待逻辑和 60 分钟窗口一起重新梳理一遍'

const STAGGER_IDS = Array.from({ length: 8 }, (_, i) => `stagger-${i}`)

const HINT_CARDS = [
  { agent: { kind: 'cursor' }, inject: 'boundary', accepting: true },
  { agent: { kind: 'claude-desktop' }, inject: 'poll', accepting: true },
  { agent: { kind: 'codex' }, inject: 'poll', accepting: true },
  { agent: { kind: 'claude-code' }, inject: 'push', accepting: false },
] as const

function StaggerDemo() {
  const { reduced } = useMotionPreference()
  return (
    <ul className="grid w-full grid-cols-4 gap-2">
      {STAGGER_IDS.map((id, i) => (
        <motion.li key={id} {...entrance(i, reduced)} className="flex justify-center">
          <AgentFace id={id} size={28} />
        </motion.li>
      ))}
    </ul>
  )
}

export function ContentSection() {
  return (
    <GallerySection id="content" title="数字、时间、长文本">
      <Specimen label="时间（§8）" className="flex-col">
        <dl className="grid w-full grid-cols-2 gap-1 text-sm">
          {TIMES.map(([label, ts]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="m-0 font-semibold">
                <RelativeTime ts={ts} now={GALLERY_NOW} />
              </dd>
            </div>
          ))}
          <dt className="text-muted">敲门 128 条</dt>
          <dd className="m-0 font-semibold">{formatCount(128)}</dd>
        </dl>
      </Specimen>
      <Specimen label="没答上的原因" className="flex-col text-sm">
        {(['not_in_room', 'target_lost', 'expired', 'no_reply'] as const).map((reason) => (
          <span key={reason}>⊘ 没答上：{failReasonText(reason)}</span>
        ))}
        <span>对方没接这个问题：{failReasonText('declined', '我这边没有权限看支付仓库')}</span>
      </Specimen>
      <Specimen label="可达性提示（§6）" className="flex-col">
        {HINT_CARDS.map((card) => (
          <ReachabilityHint key={`${card.agent.kind}-${card.inject}`} card={card} className="w-full" />
        ))}
      </Specimen>
      <Specimen label="长标题 · 长模型名 · 很多房间标签">
        <Card className="flex w-full max-w-sm gap-3 p-4">
          <AgentFace id="sess-05" size={44} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <TruncatedText text={LONG_TITLE} lines={2} tooltip className="text-card font-semibold" />
            <div className="flex min-w-0 gap-1">
              <Chip>Cursor</Chip>
              <Chip tone="violet" className="min-w-0">
                <TruncatedText text="claude-opus-4-5-20251101-thinking-preview" tooltip />
              </Chip>
            </div>
            <div className="flex min-w-0 gap-1">
              <Chip tone="muted">⌂ timely</Chip>
              <Chip tone="muted" className="min-w-0">
                <TruncatedText text="支付中台-退款链路-2026Q4-联调" />
              </Chip>
              <Chip tone="ink">+3</Chip>
            </div>
          </div>
        </Card>
      </Specimen>
      <Specimen label="长用户名（中间截断）" className="flex-col">
        <TruncatedText text="a.very.long.username.example.from.infra" middle={22} className="font-semibold" />
      </Specimen>
      <Specimen label="插件太旧 · 过了 60 分钟窗口" className="flex-col">
        <WarnBox icon={<CircleAlert />} className="w-full">
          {outdatedPluginText('0.3.2', '0.4.0')}
        </WarnBox>
        <Button size="sm" variant="lime">
          复制升级命令
        </Button>
        <WarnBox className="w-full">{boundaryReminderText('cursor', 1)}</WarnBox>
      </Specimen>
      <Specimen label="入场动画：只有前 6 个错开">
        <StaggerDemo />
      </Specimen>
    </GallerySection>
  )
}
