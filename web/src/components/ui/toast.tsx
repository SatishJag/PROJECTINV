import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type ToastTone = 'success' | 'danger' | 'info' | 'warning'
interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  message?: string
  code?: string
}
interface ToastApi {
  push: (t: Omit<ToastItem, 'id'>) => void
}

const Ctx = createContext<ToastApi>({ push: () => undefined })
export const useToast = () => useContext(Ctx)

const icons = { success: CheckCircle2, danger: XCircle, info: Info, warning: TriangleAlert }
const tones = {
  success: 'border-l-success',
  danger: 'border-l-danger',
  info: 'border-l-info',
  warning: 'border-l-warning',
}
const iconTones = { success: 'text-success', danger: 'text-danger', info: 'text-info', warning: 'text-warning' }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++seq.current
      setItems((xs) => [...xs.slice(-3), { ...t, id }])
      window.setTimeout(() => dismiss(id), t.tone === 'danger' ? 9000 : 4500)
    },
    [dismiss],
  )
  const api = useMemo(() => ({ push }), [push])
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[min(380px,calc(100vw-24px))] flex-col gap-2" aria-live="polite" aria-relevant="additions">
        {items.map((t) => {
          const Icon = icons[t.tone]
          return (
            <div key={t.id} role={t.tone === 'danger' ? 'alert' : 'status'} className={cn('pointer-events-auto flex gap-2.5 rounded-md border border-l-4 bg-card p-3 shadow-lg', tones[t.tone])}>
              <Icon className={cn('mt-0.5 size-4 shrink-0', iconTones[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold">{t.title}</p>
                {t.message ? <p className="mt-0.5 text-xs text-muted-foreground">{t.message}</p> : null}
                {t.code ? <p className="code mt-1 text-[10px] text-muted-foreground">{t.code}</p> : null}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="self-start rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label="Dismiss notification">
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}
