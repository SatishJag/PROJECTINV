import { ChevronRight, Menu, Sparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import { useSession } from '@/auth/AuthProvider'
import { Dialog } from '@/components/ui/dialog'
import { useMediaQuery } from '@/layout/theme'
import { cn } from '@/lib/utils'
import { ContextBar } from './ContextBar'
import { WORKSPACES, type Workspace } from './nav'

function allowed(w: Workspace, canSeeCommercial: boolean, roles: string[], supplier: boolean): boolean {
  if (w.key === 'dashboard' && supplier) return false
  if (supplier && w.key !== 'sourcing') return false
  if (w.commercial && !canSeeCommercial) return false
  if (w.roles && !w.roles.some((r) => roles.includes(r))) return false
  return true
}

function NavTree({ onNavigate }: { onNavigate?: () => void }) {
  const s = useSession()
  const { pathname } = useLocation()
  const workspaces = WORKSPACES.filter((w) => allowed(w, s.canSeeCommercial, s.roles, s.isSupplier))
  return (
    <nav aria-label="Workspaces" className="flex flex-col gap-1">
      {workspaces.map((w) => {
        const active = w.key === 'dashboard' ? pathname === '/' : pathname.startsWith(`/${w.key}`)
        return (
          <div key={w.key}>
            <NavLink
              to={w.to}
              end={w.key === 'dashboard'}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
                active ? 'bg-white/[0.10] text-ink-foreground' : 'text-ink-muted hover:bg-white/[0.06] hover:text-ink-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <w.icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-ink-muted')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{w.label}</span>
              {active && w.items.length > 0 ? <ChevronRight className="size-3.5 opacity-60" aria-hidden /> : null}
            </NavLink>
            {active && w.items.length > 0 ? (
              <ul className="mb-1 mt-0.5 space-y-0.5 border-l border-white/15 pl-3.5">
                {w.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          'block rounded px-2 py-1.5 text-[12px] transition-colors',
                          isActive ? 'bg-white/[0.08] font-medium text-ink-foreground' : 'text-ink-muted hover:bg-white/[0.05] hover:text-ink-foreground',
                        )
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="grid size-8 place-items-center rounded-md bg-accent text-[12px] font-bold tracking-tight text-accent-foreground">PCX</span>
      <div className="min-w-0">
        <p className="truncate text-[12px] font-semibold leading-tight text-ink-foreground">Equipment Intelligence</p>
        <p className="truncate text-[10px] text-ink-muted">Programme operations</p>
      </div>
    </div>
  )
}

/** Application frame: persistent workspace rail, context header and the routed page. */
export function AppShell({ children }: { children: ReactNode }) {
  const narrow = useMediaQuery('(max-width: 1023px)')
  const [navOpen, setNavOpen] = useState(false)

  if (narrow) {
    return (
      <div className="flex min-h-svh flex-col">
        <ContextBar
          compact
          leading={
            <button type="button" onClick={() => setNavOpen(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Open workspace navigation">
              <Menu className="size-5" aria-hidden />
            </button>
          }
        />
        <main id="main" className="min-w-0 flex-1 p-3">
          {children}
        </main>
        <Dialog open={navOpen} onOpenChange={setNavOpen} title="Workspaces" description="Switch between the operational areas available to your roles.">
          <div className="rounded-lg bg-ink p-2">
            <div className="pb-2">
              <Brand />
            </div>
            <NavTree onNavigate={() => setNavOpen(false)} />
          </div>
        </Dialog>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-[13px] focus:shadow">
        Skip to content
      </a>
      <aside className="sticky top-0 flex h-svh w-60 shrink-0 flex-col bg-ink py-3">
        <Brand />
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2">
          <NavTree />
        </div>
        <div className="mx-3 mt-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            <Sparkles className="size-3 text-accent" aria-hidden />
            Evidence-first
          </p>
          <p className="mt-1 text-[10px] leading-snug text-ink-muted">Every command is audited. Unknown values stay unknown — never zero.</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ContextBar compact={false} />
        <main id="main" className="mx-auto w-full max-w-[1560px] flex-1 px-5 py-4">
          {children}
        </main>
      </div>
    </div>
  )
}
