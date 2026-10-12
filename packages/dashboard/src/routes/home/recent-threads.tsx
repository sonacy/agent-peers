/** 刚刚聊过 (DASHBOARD §4.1): the latest 2–4 Q&A threads, compact, with a link to 问答. */
import { ArrowRight } from 'lucide-react'
import { Link } from 'wouter'
import { useAsks, useMe, useRoomTitles } from '../../api/queries'
import { NoAsksEmpty } from '../../components/empty-state'
import { SectionHeader } from '../../components/page-header'
import { QAThread } from '../../components/qa/qa-thread'
import { CardSkeleton, DelayedSkeleton } from '../../components/ui/skeleton'

export const RECENT_LIMIT = 4

export function RecentThreads() {
  const asks = useAsks('all')
  const me = useMe()
  const titleOf = useRoomTitles()
  const threads = (asks.data?.pages[0]?.asks ?? []).slice(0, RECENT_LIMIT)
  return (
    <section aria-labelledby="recent-title" className="flex flex-col gap-4">
      <SectionHeader title="刚刚聊过" id="recent-title">
        <Link
          href="/asks"
          className="focus-ring inline-flex min-h-11 items-center gap-1 self-start rounded-lg font-semibold text-primary-ink text-sm hover:underline sm:self-auto"
        >
          全部问答
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </SectionHeader>
      <DelayedSkeleton
        loading={asks.isPending}
        fallback={<CardSkeleton className="h-28" />}
        label="正在加载问答…"
      >
        {asks.isError ? <p className="text-muted text-sm">问答暂时拿不到，等会儿刷新看看。</p> : null}
        {asks.isSuccess && threads.length === 0 ? <NoAsksEmpty /> : null}
        {threads.length > 0 ? (
          <ul className="grid items-start gap-4 md:grid-cols-2">
            {threads.map((thread) => (
              <li key={thread.ask.ask_id} className="flex min-w-0">
                <QAThread
                  thread={thread}
                  me={me.data?.name}
                  roomTitle={titleOf(thread.room)}
                  compact
                  className="w-full"
                />
              </li>
            ))}
          </ul>
        ) : null}
      </DelayedSkeleton>
    </section>
  )
}
