/** Empty, loading and error states (DASHBOARD §5). */
import { useState } from 'react'
import { AgentFace } from '../../../components/agent-face'
import { NoAgentsEmpty, NoAsksEmpty, NoRoomsEmpty } from '../../../components/empty-state'
import { HubErrorBanner, StaleData } from '../../../components/error-banner'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { CardSkeleton, DelayedSkeleton } from '../../../components/ui/skeleton'
import { useToast } from '../../../components/ui/toast'
import { GallerySection, Specimen } from '../kit'

function SkeletonDemo() {
  const [loading, setLoading] = useState(true)
  return (
    <div className="flex w-full flex-col gap-2">
      <Button size="sm" onClick={() => setLoading((v) => !v)}>
        {loading ? '加载完成' : '重新加载'}
      </Button>
      <DelayedSkeleton
        loading={loading}
        fallback={
          <div className="flex flex-col gap-2">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        }
      >
        <p className="text-muted text-sm">数据到了。</p>
      </DelayedSkeleton>
    </div>
  )
}

export function StatesSection() {
  const { toast } = useToast()
  const note = (title: string) => () => toast({ title })
  return (
    <GallerySection id="states" title="空、加载、出错">
      <Specimen label="空：还没有 agent">
        <NoAgentsEmpty className="w-full" />
      </Specimen>
      <Specimen label="空：还没有房间">
        <NoRoomsEmpty className="w-full" onCreate={note('新建房间')} onFind={note('找房间')} />
      </Specimen>
      <Specimen label="空：还没有问答">
        <NoAsksEmpty className="w-full" />
      </Specimen>
      <Specimen label="加载中（超过 300ms 才出现）">
        <SkeletonDemo />
      </Specimen>
      <Specimen label="出错：连不上 Core" className="flex-col" wide>
        <HubErrorBanner
          host="localhost:7300"
          retryInSeconds={12}
          onRetry={note('现在重试')}
          className="w-full"
        />
        <StaleData stale className="w-full">
          <Card className="flex items-center gap-3 p-4">
            <AgentFace id="sess-02" size={44} />
            <span className="text-card font-semibold">调研 T3Code 项目</span>
          </Card>
        </StaleData>
      </Specimen>
    </GallerySection>
  )
}
