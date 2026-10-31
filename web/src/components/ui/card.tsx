import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card({ className, ...props }, ref) {
  return <div ref={ref} className={cn('rounded-lg border bg-card text-card-foreground shadow-[0_1px_0_rgba(16,40,59,0.04)]', className)} {...props} />
})

export function CardHeader({ title, description, actions, className, as: As = 'h2' }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; as?: 'h2' | 'h3' }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-2 border-b px-4 py-2.5', className)}>
      <div className="min-w-0">
        <As className="text-[13px] font-semibold tracking-tight">{title}</As>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />
}
