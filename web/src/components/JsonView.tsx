import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Collapsible JSON block for payloads and audit snapshots. */
export function JsonView({ value, label = 'Payload', defaultOpen = false, className }: { value: unknown; label?: string; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  const text = JSON.stringify(value ?? null, null, 2)
  return (
    <div className={cn('rounded-md border bg-muted/30', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
        {label}
      </button>
      {open ? <pre className="max-h-72 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed">{text}</pre> : null}
    </div>
  )
}
