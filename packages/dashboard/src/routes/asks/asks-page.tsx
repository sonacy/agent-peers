/**
 * 问答 (DASHBOARD §4.4): everything my agents asked or were asked, newest first, with a segmented
 * filter and infinite scroll.
 */
import { motion } from 'motion/react'
import { useState } from 'react'
import { friendlyError } from '../../api/errors'
import { flattenAsks, useAsks, useMe, useRoomTitles } from '../../api/queries'
import type { AskFilter } from '../../api/types'
import { NoAsksEmpty } from '../../components/empty-state'
import { ErrorBanner } from '../../components/error-banner'
import { PageHeader } from '../../components/page-header'
import { QAThread } from '../../components/qa/qa-thread'
import { Segmented } from '../../components/ui/segmented'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'
import { entrance } from '../../lib/motion'
import { useMotionPreference } from '../../lib/motion-preference'
import { LoadMore } from './load-more'

export const ASK_FILTER_OPTIONS: readonly { readonly value: AskFilter; readonly label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '我问的' },
  { value: 'to_me', label: '问我的' },
]

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <CardSkeleton className="h-36 items-start" />
      <CardSkeleton className="h-36 items-start" />
    </div>
  )
}

function Threads({ filter }: { readonly filter: AskFilter }) {
  const asks = useAsks(filter)
  const me = useMe()
  const titleOf = useRoomTitles()
  const { reduced } = useMotionPreference()
  const threads = flattenAsks(asks.data)
  return (
    <>
      {asks.isError && asks.data === undefined ? (
        <ErrorBanner
          title="问答没加载出来"
          description={friendlyError(asks.error)}
          actionLabel="重试"
          onAction={() => void asks.refetch()}
        />
      ) : null}
      <DelayedSkeleton loading={asks.isPending} fallback={<ListSkeleton />} label="正在加载问答…">
        {asks.isSuccess && threads.length === 0 ? <NoAsksEmpty /> : null}
        <ul className="flex flex-col gap-4">
          {threads.map((thread, index) => (
            <motion.li key={thread.ask.ask_id} {...entrance(index, reduced)} className="min-w-0">
              <QAThread thread={thread} me={me.data?.name} roomTitle={titleOf(thread.room)} />
            </motion.li>
          ))}
        </ul>
        {threads.length > 0 ? (
          <LoadMore
            hasMore={asks.hasNextPage}
            loading={asks.isFetchingNextPage}
            failed={asks.isFetchNextPageError}
            onLoad={() => void asks.fetchNextPage()}
            shown={threads.length}
          />
        ) : null}
      </DelayedSkeleton>
    </>
  )
}

export default function AsksPage() {
  const [filter, setFilter] = useState<AskFilter>('all')
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        title="问答"
        subtitle="你的 agent 问过别人的、被别人问过的，都在这里。"
        actions={
          <Segmented label="筛选问答" value={filter} options={ASK_FILTER_OPTIONS} onValueChange={setFilter} />
        }
      />
      <Threads key={filter} filter={filter} />
    </div>
  )
}
