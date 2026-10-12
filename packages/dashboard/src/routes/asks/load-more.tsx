/**
 * Infinite scroll footer: loads the next page when it scrolls into view, with a real button as the
 * accessible (and IntersectionObserver-less) fallback.
 */
import { useEffect, useRef } from 'react'
import { Button } from '../../components/ui/button'

export interface LoadMoreProps {
  readonly hasMore: boolean
  readonly loading: boolean
  readonly failed?: boolean
  readonly onLoad: () => void
  readonly shown: number
}

export function LoadMore({ hasMore, loading, failed = false, onLoad, shown }: LoadMoreProps) {
  const sentinel = useRef<HTMLDivElement>(null)
  const latest = useRef(onLoad)
  useEffect(() => {
    latest.current = onLoad
  })
  useEffect(() => {
    const node = sentinel.current
    if (!hasMore || loading || failed || node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current()
      },
      { rootMargin: '400px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, failed])
  return (
    <div ref={sentinel} className="flex flex-col items-center gap-2 py-4 text-meta text-muted">
      {failed ? <p role="alert">下一页没加载出来，点一下再试。</p> : null}
      {hasMore ? (
        <Button size="sm" onClick={onLoad} disabled={loading}>
          {loading ? '正在加载…' : '加载更多'}
        </Button>
      ) : (
        <p>已显示全部 {shown} 条</p>
      )}
    </div>
  )
}
