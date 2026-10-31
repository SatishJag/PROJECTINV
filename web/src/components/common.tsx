import { AlertTriangle, CircleSlash, Copy, Inbox, Lock, RefreshCw, ServerCrash } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { describeError, isApiError, type ApiError } from '@/api/client'
import { useSession } from '@/auth/AuthProvider'
import { formatDate, formatDateTime, formatMoney, formatQty } from '@/lib/format'
import { cn, humanize } from '@/lib/utils'
import { Badge, type Tone } from './ui/badge'
import { Button } from './ui/button'

// ---------------------------------------------------------------- value renderers

/** An unknown value is shown as "Unknown", never as 0 or blank. */
export function Unknown({ reason, label = 'Unknown' }: { reason?: string | null; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground italic" title={reason ?? 'No evidence available'}>
      <CircleSlash className="size-3" aria-hidden />
      {label}
      {reason ? <span className="sr-only">: {reason}</span> : null}
    </span>
  )
}

export function Restricted() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" title="Commercial values are restricted for your role">
      <Lock className="size-3" aria-hidden />
      Restricted
    </span>
  )
}

/** Money: hidden for non-commercial roles; null → Unknown. */
export function Money({ value, currency, commercial = true, reason, className }: { value: string | null | undefined; currency?: string | null; commercial?: boolean; reason?: string | null; className?: string }) {
  const { canSeeCommercial } = useSession()
  if (commercial && !canSeeCommercial) return <Restricted />
  const s = formatMoney(value ?? null, currency)
  if (s === null) return <Unknown reason={reason} />
  return <span className={cn('tabular-nums', className)}>{s}</span>
}

export function Qty({ value, uom }: { value: string | number | null | undefined; uom?: string | null }) {
  const s = formatQty(value ?? null, uom)
  return s === null ? <Unknown /> : <span className="tabular-nums">{s}</span>
}

export function DateText({ value, unknownLabel }: { value: string | null | undefined; unknownLabel?: string }) {
  const s = formatDate(value)
  return s === null ? <Unknown label={unknownLabel} /> : <time dateTime={value ?? undefined}>{s}</time>
}

export function DateTimeText({ value, unknownLabel = 'Not recorded' }: { value: string | null | undefined; unknownLabel?: string }) {
  const s = formatDateTime(value)
  return s === null ? <span className="text-muted-foreground">{unknownLabel}</span> : <time dateTime={value ?? undefined} title={value ?? undefined}>{s}</time>
}

export function Mono({ children, copy, className }: { children: string | null | undefined; copy?: boolean; className?: string }) {
  const [done, setDone] = useState(false)
  if (!children) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn('code inline-flex max-w-full items-center gap-1 break-all', className)}>
      {children}
      {copy ? (
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={done ? 'Copied' : `Copy ${children}`}
          onClick={() => {
            void navigator.clipboard?.writeText(children).then(() => {
              setDone(true)
              window.setTimeout(() => setDone(false), 1500)
            })
          }}
        >
          <Copy className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  )
}

// ---------------------------------------------------------------- state badges

const TONES: Record<string, Tone> = {}
const set = (tone: Tone, states: string[]) => states.forEach((s) => (TONES[s] = tone))
set('success', ['APPROVED', 'PUBLISHED', 'PASS', 'PASSED', 'RELEASED', 'ACKNOWLEDGED', 'CONNECTED', 'RESOLVED', 'CONFIRMED', 'ACCEPTED', 'GOOD', 'APPLIED', 'ACTUAL', 'AWARDED', 'RECONCILED', 'READY', 'PROCESSED', 'VALIDATED', 'DELIVERED', 'CLOSED', 'INSTALLED', 'LINKED', 'ACK', 'OK', 'ACTIVE'])
set('warning', ['IN_REVIEW', 'PENDING', 'PROVISIONAL', 'RETEST_REQUIRED', 'SPARSE', 'OPEN', 'ON_HOLD', 'PARTIALLY_RECEIVED', 'NEEDS_REVIEW', 'VALIDATING', 'NOT_TESTED', 'CONDITIONAL', 'PROPOSED', 'WAIVED', 'TRANSIENT', 'SENT_TO_PROCUREMENT', 'REPAIRABLE', 'IN_REPAIR', 'TIMEOUT'])
set('danger', ['BLOCKED', 'FAIL', 'FAILED', 'REJECTED', 'ERROR', 'DEAD', 'UNKNOWN', 'TIMEOUT_UNKNOWN', 'STALE', 'INSUFFICIENT_EVIDENCE', 'MISSING', 'UNRESOLVED', 'REVOKED', 'INVALIDATED', 'REJECT', 'NOT_APPLIED'])
set('info', ['IN_TRANSIT', 'CALCULATED', 'ISSUED', 'DISPOSITIONED', 'COMPONENT_REMOVED', 'REPLACEMENT_FITTED', 'SIMULATED', 'ALLOCATED', 'RESERVED', 'RECEIVED', 'DISPATCHED', 'SUBMITTED', 'AMENDED'])
set('neutral', ['DRAFT', 'SUPERSEDED', 'CANCELLED', 'PLANNED', 'UNALLOCATED', 'DISCONNECTED', 'NOT_SUBMITTED', 'RETIRED', 'SCRAPPED', 'WITHDRAWN', 'EXPIRED', 'CONSUMED', 'IGNORED', 'CANDIDATE', 'ASSESSED', 'NEW', 'REVERSED'])

const LABELS: Record<string, string> = {
  TIMEOUT_UNKNOWN: 'Unconfirmed — not applied in source',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  UNALLOCATED: 'Unallocated',
  ALLOCATED: 'Planning intent',
  RESERVED: 'Oracle reserved',
}

export function stateTone(state: string | null | undefined): Tone {
  return (state && TONES[state]) || 'neutral'
}

/** State badge: colour plus readable text (never colour alone). `context` adjusts labels. */
export function StateBadge({ state, context, className }: { state: string | null | undefined; context?: 'outbox' | 'allocation'; className?: string }) {
  if (!state) return <Badge tone="neutral">Unknown</Badge>
  let label = LABELS[state] ?? humanize(state)
  if (context === 'outbox' && state === 'UNKNOWN') label = 'Unconfirmed — not applied in source'
  if (context !== 'allocation' && (state === 'ALLOCATED' || state === 'RESERVED')) label = humanize(state)
  return (
    <Badge tone={stateTone(state)} className={cn('normal-case tracking-normal', className)}>
      {label}
    </Badge>
  )
}

// ---------------------------------------------------------------- layout helpers

export function PageHeader({ eyebrow, title, description, actions, meta }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">{eyebrow}</p> : null}
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">{description}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** Navy identity band (as in the spec mockups) for record headers. */
export function IdentityBand({ items, right }: { items: { label: string; value: ReactNode }[]; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ink px-4 py-3 text-ink-foreground">
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
        {items.map((it) => (
          <div key={it.label} className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{it.label}</dt>
            <dd className="text-[14px] font-semibold">{it.value}</dd>
          </div>
        ))}
      </dl>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  )
}

export function KV({ items, cols = 3, className }: { items: { label: string; value: ReactNode; hint?: string }[]; cols?: 2 | 3 | 4; className?: string }) {
  const grid = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[cols]
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3', grid, className)}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground" title={it.hint}>
            {it.label}
          </dt>
          <dd className="mt-0.5 break-words text-[13px]">{it.value ?? <span className="text-muted-foreground">—</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Callout({ tone = 'info', title, children, icon, className, actions }: { tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'; title?: ReactNode; children?: ReactNode; icon?: ReactNode; className?: string; actions?: ReactNode }) {
  const styles = {
    info: 'border-info/30 bg-info-soft text-foreground',
    warning: 'border-warning/30 bg-warning-soft text-foreground',
    danger: 'border-danger/30 bg-danger-soft text-foreground',
    success: 'border-success/30 bg-success-soft text-foreground',
    neutral: 'border-border bg-muted text-foreground',
  }[tone]
  const iconColor = { info: 'text-info', warning: 'text-warning', danger: 'text-danger', success: 'text-success', neutral: 'text-muted-foreground' }[tone]
  return (
    <div className={cn('flex gap-2.5 rounded-md border px-3 py-2.5', styles, className)} role={tone === 'danger' ? 'alert' : undefined}>
      <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', iconColor)} aria-hidden>
        {icon ?? <AlertTriangle />}
      </span>
      <div className="min-w-0 flex-1 text-[13px]">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5', 'text-[13px] text-foreground/85')}>{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-start gap-2">{actions}</div> : null}
    </div>
  )
}

export function EmptyState({ title, message, action, icon }: { title: string; message?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="rounded-full bg-muted p-2.5 text-muted-foreground [&_svg]:size-5" aria-hidden>
        {icon ?? <Inbox />}
      </span>
      <p className="text-[13px] font-semibold">{title}</p>
      {message ? <p className="max-w-md text-xs text-muted-foreground">{message}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export function ErrorPanel({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const d = describeError(error)
  const missing = isApiError(error) && error.isEndpointMissing
  if (missing) {
    return (
      <EmptyState
        icon={<ServerCrash />}
        title="Not available yet"
        message={
          <>
            {d.message}
            {isApiError(error) ? <span className="code mt-1 block text-[10px]">{error.path.split('?')[0]}</span> : null}
          </>
        }
        action={onRetry ? <Button size="sm" onClick={onRetry}><RefreshCw aria-hidden /> Check again</Button> : undefined}
      />
    )
  }
  return (
    <div className={cn(compact ? 'p-2' : 'p-4')}>
      <Callout tone="danger" title={d.title} actions={onRetry ? <Button size="sm" onClick={onRetry}><RefreshCw aria-hidden /> Retry</Button> : undefined}>
        {d.message}
        {d.code ? <span className="code ml-1 text-[10px] text-muted-foreground">({d.code})</span> : null}
      </Callout>
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-muted', className)} aria-hidden />
}

export function LoadingBlock({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-6', i === 0 ? 'w-1/3' : 'w-full')} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  )
}

/** Renders loading / error / empty / data for a query. */
export function QueryView<T>({ q, children, empty, isEmpty, rows }: { q: UseQueryResult<T, ApiError>; children: (data: T) => ReactNode; empty?: ReactNode; isEmpty?: (d: T) => boolean; rows?: number }) {
  if (q.isPending) return <LoadingBlock rows={rows} />
  if (q.isError) return <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
  const d = q.data as T
  if (empty && (isEmpty ? isEmpty(d) : Array.isArray(d) && d.length === 0)) return <>{empty}</>
  return <>{children(d)}</>
}

export function ConflictBanner({ error, onReload }: { error: ApiError | null; onReload: () => void }) {
  if (!error) return null
  const d = describeError(error)
  return (
    <Callout tone="warning" title={d.title} actions={<Button size="sm" variant="primary" onClick={onReload}><RefreshCw aria-hidden /> Reload to review</Button>}>
      {d.message}
    </Callout>
  )
}

export function Section({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border bg-card', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function Metric({ label, value, tone, hint, to }: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode; to?: ReactNode }) {
  const bar = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info', accent: 'bg-accent', neutral: 'bg-border', outline: 'bg-border', solid: 'bg-ink' }[tone ?? 'neutral']
  return (
    <div className="relative overflow-hidden rounded-lg border bg-card px-4 py-3">
      <span className={cn('absolute inset-y-0 left-0 w-1', bar)} aria-hidden />
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      {to}
    </div>
  )
}
