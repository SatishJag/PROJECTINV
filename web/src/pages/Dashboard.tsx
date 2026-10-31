import { AlertTriangle, ArrowRight, ClipboardList, FileCheck2, Network, PackageCheck, ShieldAlert, Truck, Wrench } from 'lucide-react'
import { Link, Navigate } from 'react-router'
import { dashboard, reference } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Badge } from '@/components/ui/badge'
import { QueryView, Section, Metric, PageHeader, Callout, StateBadge, EmptyState } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table'
import { humanize } from '@/lib/utils'

function Bar({ label, count, total, tone }: { label: string; count: number; total: number; tone: string }) {
  const pct = total ? Math.round((count / total) * 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className="font-medium">{humanize(label)}</span>
        <span className="text-muted-foreground tabular-nums">
          {count} · {pct}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  )
}

export function Dashboard() {
  const s = useSession()
  const c = useAppContext()
  const summary = useApi(['dashboard', 'summary'], dashboard.summary)
  const health = useApi(['health'], reference.health, { staleTime: 60_000 })
  const audit = useApi(['audit', 'recent'], dashboard.audit({ limit: 6 }), { staleTime: 30_000 })
  if (s.isSupplier) return <Navigate replace to="/sourcing/packages" />

  const d = summary.data
  const unitsTotal = d ? Object.values(d.units_by_state).reduce((a, b) => a + b, 0) : 0
  const attention = d
    ? [
        { label: 'Open impact actions', count: d.open_impact_actions, to: '/planning/impact-actions', icon: AlertTriangle, tone: 'warning' as const },
        { label: 'Handbooks blocked', count: d.handbooks_blocked, to: '/handbook/packages?state=BLOCKED', icon: FileCheck2, tone: 'danger' as const },
        { label: 'Open recovery cases', count: d.open_recovery_cases, to: '/delivery/recovery', icon: Wrench, tone: 'warning' as const },
        { label: 'Integration exceptions', count: d.open_integration_exceptions, to: '/admin/exceptions', icon: ShieldAlert, tone: 'warning' as const },
        { label: 'Outbox unconfirmed', count: d.outbox_unknown, to: '/admin/outbox', icon: Network, tone: 'danger' as const },
      ]
    : []

  return (
    <>
      <PageHeader
        eyebrow="Programme operations"
        title={`Good day, ${s.user?.name?.split(' ')[0] ?? 'there'}`}
        description={
          <>
            {c.programme?.code ?? 'No programme'} {c.project ? `· ${c.project.code} ${c.project.name}` : '· all data centres'} · business date {c.businessDate}
            {c.evidenceCutoff ? ' · historical evidence cutoff active' : ''}
          </>
        }
        actions={
          <>
            <Badge tone={health.data?.status === 'ok' ? 'success' : 'neutral'}>{health.data?.status === 'ok' ? 'Service healthy' : 'Service status unknown'}</Badge>
            <Badge tone="outline">Procore {health.data?.procore_mode ?? '—'}</Badge>
          </>
        }
      />

      <QueryView q={summary} rows={6}>
        {(data) => (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Active requirements" value={data.requirements} tone="accent" hint={<Link to="/planning/requirements" className="text-accent hover:underline">Review planning pipeline</Link>} />
              <Metric label="Equipment units" value={unitsTotal} tone="info" hint={<Link to="/delivery/units" className="text-accent hover:underline">Asset register · fitted components included</Link>} />
              <Metric label="Handbooks published" value={data.handbooks_published} tone="success" hint={<Link to="/handbook/packages" className="text-accent hover:underline">Handbook workbench</Link>} />
              <Metric
                label="Open recovery cases"
                value={data.open_recovery_cases}
                tone={data.open_recovery_cases ? 'warning' : 'neutral'}
                hint={<Link to="/delivery/recovery" className="text-accent hover:underline">FAT &amp; recovery</Link>}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
              <Section
                title="Needs attention"
                description="Items that block or put evidence at risk."
                actions={<Link to="/planning/impact-actions" className="text-[12px] font-medium text-accent hover:underline">Impact actions <ArrowRight className="inline size-3" aria-hidden /></Link>}
              >
                <ul className="divide-y">
                  {attention.map((a) => (
                    <li key={a.label}>
                      <Link to={a.to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                        <a.icon className={`size-4 ${a.count ? (a.tone === 'danger' ? 'text-danger' : 'text-warning') : 'text-muted-foreground'}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.label}</span>
                        <Badge tone={a.count ? a.tone : 'neutral'}>{a.count}</Badge>
                        <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
                {attention.every((a) => a.count === 0) ? (
                  <div className="border-t px-4 py-3">
                    <Callout tone="success" title="No blockers">
                      All evidence, handover and integration queues are clear.
                    </Callout>
                  </div>
                ) : null}
              </Section>

              <Section title="Unit position" description="Custody state and allocation status across the programme.">
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  <div className="space-y-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Lifecycle state</p>
                    {Object.keys(data.units_by_state).length === 0 ? <p className="text-xs text-muted-foreground">No units yet.</p> : null}
                    {Object.entries(data.units_by_state)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => (
                        <Bar key={k} label={k} count={v} total={unitsTotal} tone="bg-info" />
                      ))}
                  </div>
                  <div className="space-y-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Allocation</p>
                    {Object.entries(data.units_by_allocation)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => (
                        <Bar key={k} label={k} count={v} total={unitsTotal} tone={k === 'ISSUED' ? 'bg-success' : k === 'UNALLOCATED' ? 'bg-border' : 'bg-accent'} />
                      ))}
                    <Link to="/delivery/allocation" className="inline-flex items-center gap-1 pt-1 text-[12px] font-medium text-accent hover:underline">
                      Allocation board <ArrowRight className="size-3" aria-hidden />
                    </Link>
                  </div>
                </div>
              </Section>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
              <Section title="Start from a workspace" description="The six operational areas in this product.">
                <ul className="grid gap-2 p-3 sm:grid-cols-2">
                  {[
                    { to: '/planning/requirements', label: 'Planning & BOQ', text: 'Requirements, benchmark, reuse', icon: ClipboardList },
                    { to: '/sourcing/packages', label: 'Sourcing & Award', text: 'Offers, evaluation, frozen award', icon: PackageCheck },
                    { to: '/delivery/purchase-orders', label: 'Delivery & Assets', text: 'PO identity, custody, arrival', icon: Truck },
                    { to: '/handbook/packages', label: 'Handbook & Ops', text: 'Validation, publish, FM work', icon: FileCheck2 },
                    { to: '/costs/events', label: 'Cost Intelligence', text: 'Attribution, rollup, TCO', icon: Network },
                    { to: '/admin/procore', label: 'Administration', text: 'Procore, outbox, exceptions', icon: ShieldAlert },
                  ]
                    .filter((x) => !(x.to === '/costs/events' && !s.canSeeCommercial) && !(x.to.startsWith('/admin') && !s.roles.some((r) => ['ADMIN', 'INTEGRATION', 'OWNER'].includes(r))))
                    .map((x) => (
                      <li key={x.to}>
                        <Link to={x.to} className="flex items-start gap-2 rounded-md border px-3 py-2 hover:bg-muted/60">
                          <x.icon className="mt-0.5 size-4 text-accent" aria-hidden />
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold">{x.label}</p>
                            <p className="text-[11px] text-muted-foreground">{x.text}</p>
                          </div>
                        </Link>
                      </li>
                    ))}
                </ul>
              </Section>

              <Section title="Recent activity" description="Latest audited commands.">
                <QueryView q={audit} rows={4}>
                  {(events) =>
                    events.length === 0 ? (
                      <EmptyState title="No activity yet" message="Commands will appear here with actor and subject." />
                    ) : (
                      <Table caption="Recent audit events">
                        <THead>
                          <TR>
                            <TH>When</TH>
                            <TH>Action</TH>
                            <TH>Actor</TH>
                            <TH>Subject</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {events.map((e) => (
                            <TR key={e.id}>
                              <TD className="whitespace-nowrap text-muted-foreground">{new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TD>
                              <TD>
                                <span className="code">{e.action}</span>
                              </TD>
                              <TD className="truncate">{e.actor}</TD>
                              <TD>
                                <StateBadge state={e.subject_type} />
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    )
                  }
                </QueryView>
              </Section>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Business date and evidence cutoff are set in the context bar and apply to every workspace. Procore mapping: {c.mapping.state === 'mapped' ? c.mapping.context?.project?.code ?? 'mapped' : c.mapping.state}.
            </p>
          </div>
        )}
      </QueryView>
    </>
  )
}
