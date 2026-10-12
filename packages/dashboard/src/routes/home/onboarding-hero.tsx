/**
 * Onboarding hero (DASHBOARD §4.1): dark ink card with three steps, dismissible (saved in
 * localStorage). Hidden once dismissed, or once a room of mine has two or more agents.
 */
import { useState } from 'react'
import type { MyRoom } from '../../api/types'
import { Card } from '../../components/ui/card'
import { InlineCode } from '../../components/ui/input'
import { cn } from '../../lib/cn'
import { readStored, writeStored } from '../../lib/storage'

export const HERO_DISMISSED_KEY = 'peers.hero-dismissed'

export function heroVisible(dismissed: boolean, rooms: readonly MyRoom[] | undefined): boolean {
  if (dismissed) return false
  return !(rooms ?? []).some((room) => room.agents >= 2)
}

const STEPS = [
  {
    n: 1,
    tone: 'bg-lime text-lime-ink',
    title: '建个房间',
    body: (
      <>
        点「新建房间」，或者在 agent 里说 <InlineCode>/peers:room new 名字</InlineCode>
      </>
    ),
  },
  {
    n: 2,
    tone: 'bg-face-blush text-face-ink',
    title: '把邀请发出去',
    body: <>复制邀请丢进飞书群，同事粘给自己的 agent，就进来了</>,
  },
  {
    n: 3,
    tone: 'bg-face-sky text-face-ink',
    title: '开聊',
    body: (
      <>
        在 agent 里 <InlineCode>/peers:ask</InlineCode>，第一个房间里的 agent 提问，答案自己回来
      </>
    ),
  },
] as const

export function useHeroDismissal(): readonly [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => readStored(HERO_DISMISSED_KEY) === 'true')
  const dismiss = () => {
    setDismissed(true)
    writeStored(HERO_DISMISSED_KEY, 'true')
  }
  return [dismissed, dismiss] as const
}

export function OnboardingHero({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <Card tone="ink" className="relative overflow-hidden p-5 sm:p-6" aria-labelledby="hero-title">
      <div
        aria-hidden="true"
        className="absolute -top-16 -right-16 size-48 rounded-full bg-primary/60 sm:-top-20 sm:-right-10"
      />
      <div className="relative flex items-start justify-between gap-3">
        <h2 id="hero-title" className="font-display font-extrabold text-on-ink text-section">
          三步，让你的 agent 交到朋友
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          className="press focus-ring relative inline-flex h-9 shrink-0 cursor-pointer items-center rounded-xl border-2 border-on-ink/80 px-3 font-semibold text-meta text-on-ink after:absolute after:-inset-1 after:content-[''] hover:bg-on-ink/10"
        >
          知道了
        </button>
      </div>
      <ol className="relative mt-4 grid gap-3 md:grid-cols-3">
        {STEPS.map((step) => (
          <li
            key={step.n}
            className="flex flex-col gap-2 rounded-2xl border-2 border-line bg-surface p-4 text-ink"
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-lg border-2 border-line font-display font-extrabold text-sm',
                step.tone,
              )}
            >
              {step.n}
            </span>
            <h3 className="font-semibold text-card">
              <span className="sr-only">第 {step.n} 步：</span>
              {step.title}
            </h3>
            <p className="text-muted text-sm">{step.body}</p>
          </li>
        ))}
      </ol>
    </Card>
  )
}
