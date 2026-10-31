import * as DM from '@radix-ui/react-dropdown-menu'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Menu = DM.Root
export const MenuTrigger = DM.Trigger

export function MenuContent({ className, children, ...props }: ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={6} align="end" className={cn('z-50 min-w-[220px] rounded-md border bg-card p-1 text-[13px] shadow-xl', className)} {...props}>
        {children}
      </DM.Content>
    </DM.Portal>
  )
}

export function MenuItem({ className, ...props }: ComponentProps<typeof DM.Item>) {
  return <DM.Item className={cn('flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-muted [&_svg]:size-4', className)} {...props} />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</DM.Label>
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-border" />
}
