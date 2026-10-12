/** Toasts (e.g. `已复制，粘到群里吧`) on Radix Toast, driven by `useToast()`. */
import { X } from 'lucide-react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

export type ToastTone = 'default' | 'success' | 'danger'

export interface ToastInput {
  readonly title: string
  readonly description?: string
  readonly tone?: ToastTone
  readonly durationMs?: number
}

export interface ToastItem extends ToastInput {
  readonly id: number
}

interface ToastApi {
  readonly toast: (input: ToastInput) => number
  readonly dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | undefined>(undefined)

const TONE: Readonly<Record<ToastTone, string>> = {
  default: 'bg-surface text-ink',
  success: 'bg-lime text-lime-ink',
  danger: 'bg-danger-soft text-danger',
}

export const DEFAULT_TOAST_MS = 3000
/** Danger toasts say why and what to do next (§9): long enough to read two lines (WCAG 2.2.1). */
export const DANGER_TOAST_MS = 10_000

export function toastDuration(item: Pick<ToastInput, 'durationMs' | 'tone'>): number {
  return item.durationMs ?? (item.tone === 'danger' ? DANGER_TOAST_MS : DEFAULT_TOAST_MS)
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<readonly ToastItem[]>([])
  const nextId = useRef(1)
  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((item) => item.id !== id)), [])
  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++
    setItems((prev) => [...prev, { ...input, id }])
    return id
  }, [])
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss])
  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="down" label="通知">
        {children}
        {items.map((item) => (
          <ToastView key={item.id} item={item} onClose={() => dismiss(item.id)} />
        ))}
        <ToastPrimitive.Viewport className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] mx-auto flex w-full max-w-sm flex-col gap-2 px-4 outline-none sm:right-6 sm:bottom-6 sm:left-auto sm:mx-0" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}

function ToastView({ item, onClose }: { readonly item: ToastItem; readonly onClose: () => void }) {
  return (
    <ToastPrimitive.Root
      duration={toastDuration(item)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      className={cn(
        'flex items-start gap-3 rounded-2xl border-2 border-line p-3 pl-4 shadow-hard animate-sheet-up',
        TONE[item.tone ?? 'default'],
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <ToastPrimitive.Title className="font-semibold text-sm">{item.title}</ToastPrimitive.Title>
        {item.description === undefined ? null : (
          <ToastPrimitive.Description className="text-meta opacity-80">
            {item.description}
          </ToastPrimitive.Description>
        )}
      </div>
      <ToastPrimitive.Close
        aria-label="关闭通知"
        className="focus-ring -m-1 inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg opacity-70 hover:opacity-100"
      >
        <X className="size-4" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === undefined) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}
