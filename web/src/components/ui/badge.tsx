import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const badgeVariants = cva('inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap leading-4', {
  variants: {
    tone: {
      neutral: 'border-border bg-muted text-muted-foreground',
      success: 'border-transparent bg-success-soft text-success',
      warning: 'border-transparent bg-warning-soft text-warning',
      danger: 'border-transparent bg-danger-soft text-danger',
      info: 'border-transparent bg-info-soft text-info',
      accent: 'border-transparent bg-accent-soft text-accent',
      outline: 'border-input bg-transparent text-foreground',
      solid: 'border-transparent bg-ink text-ink-foreground',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}

/** Small dot + label, for use where a full badge is too heavy. Status text is always present. */
export function StatusDot({ tone = 'neutral', label, className }: { tone?: Tone; label: string; className?: string }) {
  const color: Record<Tone, string> = {
    neutral: 'bg-muted-foreground',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    accent: 'bg-accent',
    outline: 'bg-foreground',
    solid: 'bg-ink',
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={cn('size-2 rounded-full', color[tone])} aria-hidden />
      {label}
    </span>
  )
}
