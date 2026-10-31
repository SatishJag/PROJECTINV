import * as Pop from '@radix-ui/react-popover'
import { Building2, CalendarDays, ChevronDown, Clock3, Link2, Link2Off, LogOut, Moon, SlidersHorizontal, Sun, UserRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useSession } from '@/auth/AuthProvider'
import { ROLE_LABELS } from '@/auth/permissions'
import { useAppContext } from '@/context/AppContext'
import { formatDate, formatDateTime, isoToLocalInput, localInputToISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { useTheme } from './theme'

function Chip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col justify-center', className)}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{label}</span>
      <span className="truncate text-[13px] font-medium">{children}</span>
    </div>
  )
}

function ProcoreMapping() {
  const { launch, mapping, embedded } = useAppContext()
  const has = !!(launch.companyId || launch.projectId)
  const tone = mapping.state === 'mapped' ? 'success' : mapping.state === 'loading' ? 'neutral' : has ? 'warning' : 'neutral'
  const label =
    mapping.state === 'mapped'
      ? `Mapped to ${mapping.context?.project?.code ?? 'project'}`
      : mapping.state === 'unmapped'
        ? 'No PCX project mapped'
        : mapping.state === 'loading'
          ? 'Resolving…'
          : mapping.state === 'error'
            ? 'Mapping unavailable'
            : 'Standalone'
  return (
    <Pop.Root>
      <Pop.Trigger asChild>
        <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted" aria-label={`Procore context: ${label}`}>
          {mapping.state === 'mapped' ? <Link2 className="size-4 text-success" aria-hidden /> : <Link2Off className="size-4 text-muted-foreground" aria-hidden />}
          <Chip label={embedded ? 'Procore (embedded)' : 'Procore'}>
            <Badge tone={tone} className="normal-case tracking-normal">
              {label}
            </Badge>
          </Chip>
        </button>
      </Pop.Trigger>
      <Pop.Portal>
        <Pop.Content sideOffset={6} align="start" className="z-50 w-72 rounded-md border bg-card p-3 text-[13px] shadow-xl">
          <p className="font-semibold">Procore company / project mapping</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Company</dt>
            <dd className="code">{launch.companyId ?? '—'}</dd>
            <dt className="text-muted-foreground">Project</dt>
            <dd className="code">{launch.projectId ?? '—'}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd>{launch.source ?? 'none (opened outside Procore)'}</dd>
            <dt className="text-muted-foreground">PCX project</dt>
            <dd>{mapping.context?.project ? `${mapping.context.project.code} · ${mapping.context.project.name}` : '—'}</dd>
          </dl>
          {mapping.message ? <p className="mt-2 text-xs text-muted-foreground">{mapping.message}</p> : null}
          <Pop.Arrow className="fill-card" />
        </Pop.Content>
      </Pop.Portal>
    </Pop.Root>
  )
}

function ContextControls({ stacked }: { stacked?: boolean }) {
  const c = useAppContext()
  return (
    <div className={cn('flex gap-3', stacked ? 'flex-col' : 'flex-wrap items-end')}>
      <Field label="Programme" className={stacked ? '' : 'w-40'}>
        <Select value={c.programmeId ?? ''} onChange={(e) => c.setProgramme(e.target.value || null)}>
          {c.programmes.length === 0 ? <option value="">No programmes</option> : null}
          {c.programmes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Data centre / project" className={stacked ? '' : 'w-44'}>
        <Select value={c.projectId ?? ''} onChange={(e) => c.setProject(e.target.value || null)}>
          <option value="">All projects in programme</option>
          {c.programmeProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
              {p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Business date" className={stacked ? '' : 'w-36'}>
        <Input type="date" value={c.businessDate} onChange={(e) => e.target.value && c.setBusinessDate(e.target.value)} />
      </Field>
      <EvidenceCutoffField />
    </div>
  )
}

function EvidenceCutoffField() {
  const c = useAppContext()
  return (
    <div className="flex flex-col gap-1">
      <Field label="Evidence cutoff" hint={c.evidenceCutoff ? undefined : 'Live — all evidence up to now'}>
        <Input type="datetime-local" value={isoToLocalInput(c.evidenceCutoff)} onChange={(e) => c.setEvidenceCutoff(localInputToISO(e.target.value))} className="w-48" />
      </Field>
      {c.evidenceCutoff ? (
        <Button variant="link" size="sm" className="self-start text-xs" onClick={() => c.setEvidenceCutoff(null)}>
          Reset to live
        </Button>
      ) : null}
    </div>
  )
}

function UserMenu() {
  const s = useSession()
  const { theme, toggle } = useTheme()
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted" aria-label={`Account: ${s.user?.name ?? ''}`}>
          <span className="grid size-7 place-items-center rounded-full bg-ink text-[11px] font-semibold text-ink-foreground" aria-hidden>
            {(s.user?.name ?? '?')
              .split(' ')
              .map((x) => x[0])
              .slice(0, 2)
              .join('')}
          </span>
          <span className="hidden min-w-0 flex-col text-left xl:flex">
            <span className="truncate text-[13px] font-medium leading-tight">{s.user?.name}</span>
            <span className="truncate text-[11px] text-muted-foreground">{s.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}</span>
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Signed in</MenuLabel>
        <div className="px-2 pb-2">
          <p className="text-[13px] font-medium">{s.user?.name}</p>
          <p className="text-xs text-muted-foreground">{s.user?.email}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.roles.map((r) => (
              <Badge key={r} tone="outline">
                {ROLE_LABELS[r] ?? r}
              </Badge>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Commercial fields: {s.canSeeCommercial ? 'visible' : 'hidden for your role'}</p>
        </div>
        <MenuSeparator />
        <MenuItem onSelect={toggle}>
          {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />} {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </MenuItem>
        <MenuItem onSelect={s.signOut}>
          <LogOut aria-hidden /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** Persistent context header (spec §23): org, Procore mapping, programme/DC, business date, evidence cutoff, user. */
export function ContextBar({ compact, leading }: { compact: boolean; leading?: ReactNode }) {
  const s = useSession()
  const c = useAppContext()
  const [open, setOpen] = useState(false)

  if (compact) {
    return (
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card/95 px-2 py-1.5 backdrop-blur">
        {leading}
        <button type="button" onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-muted" aria-label="Change context">
          <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-[13px] font-medium">
            {c.programme?.code ?? '—'} · {c.project?.code ?? 'All DCs'} · {formatDate(c.businessDate)}
          </span>
          {c.mapping.state === 'mapped' ? <Link2 className="size-3.5 shrink-0 text-success" aria-label="Mapped to Procore project" /> : null}
        </button>
        {!s.isSupplier ? null : <Badge tone="info">Supplier</Badge>}
        <UserMenu />
        <Dialog open={open} onOpenChange={setOpen} title="Working context" description="Applies to every workspace.">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-[13px]">
              <Building2 className="size-4 text-muted-foreground" aria-hidden /> Tenant <span className="code">{s.tenantCode}</span>
            </div>
            <ProcoreMapping />
            {!s.isSupplier ? <ContextControls stacked /> : null}
          </div>
        </Dialog>
      </header>
    )
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        {leading}
        <div className="flex items-center gap-2">
          <Building2 className="size-4 text-muted-foreground" aria-hidden />
          <Chip label="Organization">
            <span className="code">{s.tenantCode}</span>
          </Chip>
        </div>
        <span className="h-7 w-px bg-border" aria-hidden />
        <ProcoreMapping />
        {!s.isSupplier ? (
          <>
            <span className="h-7 w-px bg-border" aria-hidden />
            <label className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">Programme</span>
              <select className="-ml-1 rounded bg-transparent px-1 text-[13px] font-medium hover:bg-muted" value={c.programmeId ?? ''} onChange={(e) => c.setProgramme(e.target.value || null)}>
                {c.programmes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">Data centre</span>
              <select className="-ml-1 rounded bg-transparent px-1 text-[13px] font-medium hover:bg-muted" value={c.projectId ?? ''} onChange={(e) => c.setProject(e.target.value || null)}>
                <option value="">All projects</option>
                {c.programmeProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="h-7 w-px bg-border" aria-hidden />
            <label className="flex flex-col">
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                <CalendarDays className="size-3" aria-hidden /> Business date
              </span>
              <input type="date" className="-ml-1 rounded bg-transparent px-1 text-[13px] font-medium hover:bg-muted" value={c.businessDate} onChange={(e) => e.target.value && c.setBusinessDate(e.target.value)} />
            </label>
            <Pop.Root>
              <Pop.Trigger asChild>
                <button type="button" className="flex flex-col rounded px-1 text-left hover:bg-muted" aria-label={`Evidence cutoff: ${c.evidenceCutoff ? formatDateTime(c.evidenceCutoff) : 'live'}. Change`}>
                  <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                    <Clock3 className="size-3" aria-hidden /> Evidence cutoff
                  </span>
                  <span className="text-[13px] font-medium">{c.evidenceCutoff ? formatDateTime(c.evidenceCutoff) : <span className="text-success">Live</span>}</span>
                </button>
              </Pop.Trigger>
              <Pop.Portal>
                <Pop.Content sideOffset={6} className="z-50 w-64 rounded-md border bg-card p-3 shadow-xl">
                  <EvidenceCutoffField />
                  <p className="mt-2 text-[11px] text-muted-foreground">Benchmarks and arrival forecasts use only evidence recorded at or before this instant.</p>
                </Pop.Content>
              </Pop.Portal>
            </Pop.Root>
          </>
        ) : (
          <Badge tone="info">Supplier portal</Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <UserRound className="sr-only" aria-hidden />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}
