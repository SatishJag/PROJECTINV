import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Semantic, dense data table. Wrapped in a scroll region so it never breaks the 400 px side panel. */
export function Table({ className, caption, children, captionHidden = true, ...props }: HTMLAttributes<HTMLTableElement> & { caption: string; captionHidden?: boolean }) {
  return (
    <div className="w-full overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
      <table className={cn('w-full border-collapse text-[13px]', className)} {...props}>
        <caption className={captionHidden ? 'sr-only' : 'px-3 py-2 text-left text-xs text-muted-foreground'}>{caption}</caption>
        {children}
      </table>
    </div>
  )
}
export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-muted/60 text-left', className)} {...props} />
}
export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&>tr:last-child]:border-0', className)} {...props} />
}
export function TR({ className, selected, ...props }: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return <tr className={cn('border-b transition-colors hover:bg-muted/40', selected && 'bg-accent-soft/60 hover:bg-accent-soft/70', className)} aria-selected={selected || undefined} {...props} />
}
export function TH({ className, numeric, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th scope="col" className={cn('h-8 whitespace-nowrap px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', numeric && 'text-right', className)} {...props} />
}
export function TD({ className, numeric, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cn('px-3 py-1.5 align-top', numeric && 'num', className)} {...props} />
}
export function RowHeader({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="row" className={cn('px-3 py-1.5 text-left align-top font-medium', className)} {...props} />
}

export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-[13px] text-muted-foreground">
        {children}
      </td>
    </tr>
  )
}
