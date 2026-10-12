/** Buttons, chips, badges, switches, tabs and inputs in every state. */
import { Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Chip, FilterChip } from '../../../components/ui/chip'
import { Input, SearchInput } from '../../../components/ui/input'
import { Segmented } from '../../../components/ui/segmented'
import { Switch } from '../../../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs'
import { GallerySection, Specimen } from '../kit'

const VARIANTS = ['primary', 'secondary', 'lime', 'danger-outline', 'ghost'] as const
const FILTERS = [
  ['all', '全部 4'],
  ['idle', '有空 2'],
  ['busy', '正在忙 1'],
  ['offline', '离线 1'],
] as const
type AskFilter = 'all' | 'mine' | 'to_me'

export function ControlsSection() {
  const [filter, setFilter] = useState('all')
  const [accepting, setAccepting] = useState(true)
  const [segment, setSegment] = useState<AskFilter>('all')
  const [query, setQuery] = useState('api')
  return (
    <GallerySection id="controls" title="按钮和控件">
      <Specimen label="按钮 variants" wide>
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
        <Button variant="primary">
          <Plus /> 新建房间
        </Button>
        <Button>
          <Search /> 找房间
        </Button>
        <Button variant="primary" disabled>
          disabled
        </Button>
      </Specimen>
      <Specimen label="按钮尺寸">
        <Button size="sm" variant="lime">
          敲门申请
        </Button>
        <Button size="md">md</Button>
        <Button size="lg" variant="primary">
          lg
        </Button>
        <Button size="icon" aria-label="新建">
          <Plus />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="更多">
          ⋯
        </Button>
        <Button block variant="primary">
          复制邀请（整行宽）
        </Button>
      </Specimen>
      <Specimen label="Chips">
        <Chip>Claude Code</Chip>
        <Chip tone="violet">Opus 4.5</Chip>
        <Chip tone="lime">房主</Chip>
        <Chip>成员</Chip>
        <Chip tone="ink">我</Chip>
        <Chip tone="blush">2 人在敲门</Chip>
        <Chip tone="warn">等开门</Chip>
        <Chip tone="muted">⌂ timely</Chip>
        <Chip size="md">3 人 · 5 个 agent</Chip>
      </Specimen>
      <Specimen label="筛选 chips（可滚动）" className="scrollbar-none flex-nowrap overflow-x-auto pb-1">
        {FILTERS.map(([value, label]) => (
          <FilterChip key={value} selected={filter === value} onClick={() => setFilter(value)}>
            {label}
          </FilterChip>
        ))}
      </Specimen>
      <Specimen label="Badges（99+ 封顶）" className="items-center">
        <Badge count={0} hideZero={false} />
        <Badge count={2} label="2 人在敲门" />
        <Badge count={99} tone="lime" />
        <Badge count={128} tone="blush" label="128 人在敲门" />
        <Badge count={7} tone="ink" />
      </Specimen>
      <Specimen label="Switch" className="items-center">
        <div className="flex items-center gap-3 text-sm">
          <label htmlFor="gallery-accepting">接受提问</label>
          <Switch id="gallery-accepting" checked={accepting} onCheckedChange={setAccepting} />
        </div>
        <Switch checked={false} disabled aria-label="已禁用" />
      </Specimen>
      <Specimen label="Segmented">
        <Segmented
          label="问答筛选"
          value={segment}
          onValueChange={setSegment}
          options={[
            { value: 'all', label: '全部' },
            { value: 'mine', label: '我问的' },
            { value: 'to_me', label: '问我的' },
          ]}
        />
      </Specimen>
      <Specimen label="Tabs（手机房间详情）" className="flex-col">
        <Tabs defaultValue="members" className="w-full">
          <TabsList aria-label="房间详情">
            <TabsTrigger value="members">成员</TabsTrigger>
            <TabsTrigger value="invite">邀请</TabsTrigger>
            <TabsTrigger value="knocks">
              敲门 <Badge count={128} tone="blush" />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="pt-3 text-muted text-sm">
            成员列表
          </TabsContent>
          <TabsContent value="invite" className="pt-3 text-muted text-sm">
            拉朋友进来
          </TabsContent>
          <TabsContent value="knocks" className="pt-3 text-muted text-sm">
            有人在敲门
          </TabsContent>
        </Tabs>
      </Specimen>
      <Specimen label="输入框" className="flex-col">
        <SearchInput
          label="找房间"
          placeholder="房间名或房主，比如 api"
          value={query}
          onValueChange={setQuery}
        />
        <Input aria-label="房间名" placeholder="房间名" />
        <Input aria-label="已禁用" placeholder="已禁用" disabled />
      </Specimen>
    </GallerySection>
  )
}
