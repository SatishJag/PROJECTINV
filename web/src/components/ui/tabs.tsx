import * as RT from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Tabs = RT.Root

export function TabsList({ className, ...props }: ComponentProps<typeof RT.List>) {
  return <RT.List className={cn('flex w-full gap-0.5 overflow-x-auto border-b', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RT.Trigger>) {
  return (
    <RT.Trigger
      className={cn(
        '-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[state=active]:border-accent data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RT.Content>) {
  return <RT.Content className={cn('pt-4 focus-visible:outline-none', className)} {...props} />
}
