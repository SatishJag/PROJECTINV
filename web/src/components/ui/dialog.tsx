import * as RD from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Modal dialog (Radix): focus trap, Esc to close, labelled by title/description.
 * On narrow (side panel) widths it becomes a bottom sheet.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const width = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' }[size]
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[1px] data-[state=open]:animate-in" />
        <RD.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] w-full flex-col rounded-t-xl border bg-card shadow-2xl focus:outline-none',
            'sm:inset-auto sm:left-1/2 sm:top-[8vh] sm:max-h-[84vh] sm:-translate-x-1/2 sm:rounded-lg',
            width,
          )}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-3">
            <div className="min-w-0">
              <RD.Title className="text-[15px] font-semibold tracking-tight">{title}</RD.Title>
              {description ? <RD.Description className="mt-0.5 text-xs text-muted-foreground">{description}</RD.Description> : null}
            </div>
            <RD.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close dialog">
              <X className="size-4" aria-hidden />
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/40 px-5 py-3">{footer}</div> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
