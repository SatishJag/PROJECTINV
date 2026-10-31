import { CalendarClock, Camera } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { logistics } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { ArrivalRow } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form'
import { Callout, DateText, EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { isoToLocalInput, localInputToISO } from '@/lib/format'
import { asList } from '@/lib/utils'

export function Arrival() {
  const s = useSession()
  const c = useAppContext()
  const [date, setDate] = useState(c.businessDate)
  const [asKnown, setAsKnown] = useState('')
  const [projectId, setProjectId] = useState(c.projectId ?? '')

  const q = useApi(['delivery', 'arrival', projectId || 'all', date, asKnown], logistics.arrival({ project_id: projectId || null, selected_date: date, as_known_at: localInputToISO(asKnown) }),
  )
  const snapshot = useCommand({
    run: () => logistics.snapshot(projectId || null),
    invalidate: [['delivery']],
    success: 'Arrival snapshot recorded',
  })

  const rows = asList<ArrivalRow>(q.data)
  const atRisk = rows.filter((r) => r.p_on_date === '0' || r.quality === 'UNKNOWN' || r.quality === 'STALE')

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Arrival board"
        description="Forecasts as known at a point in time. A later feed never rewrites what was known on the selected date."
        actions={
          s.can('requirement.edit') || s.can('allocation.manage') ? (
            <Button onClick={() => snapshot.mutate()} loading={snapshot.isPending}>
              <Camera aria-hidden /> Snapshot now
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-4">
        <Field label="Selected date" required>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="As known at" hint="Blank = live evidence.">
          <Input type="datetime-local" value={asKnown} onChange={(e) => setAsKnown(e.target.value)} />
        </Field>
        <Field label="Project">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button variant="ghost" onClick={() => { setAsKnown(isoToLocalInput(c.evidenceCutoff)); setDate(c.businessDate) }}>
            Use context cutoff
          </Button>
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Units tracked</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{rows.length}</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Expected on or before date</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{rows.filter((r) => r.p_on_date === '1').length}</p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">At risk / unknown</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{atRisk.length}</p>
        </div>
      </div>

      {atRisk.length ? (
        <Callout tone="warning" title={`${atRisk.length} unit${atRisk.length === 1 ? '' : 's'} need attention`} className="mb-4">
          Forecasts marked unknown or stale are never replaced with an optimistic guess. Check tracking evidence or receiving readiness.
        </Callout>
      ) : null}

      <Section title="Forecast by unit" description="Percentages are model output, not commitments; quality states the evidence basis.">
        <QueryView q={q} rows={6} empty={<EmptyState icon={<CalendarClock />} title="No forecastable units" message="Assign units to projects and record shipment milestones to populate the arrival board." />}>
          {() => (
            <Table caption="Arrival forecasts">
              <THead>
                <TR>
                  <TH>Asset</TH>
                  <TH>ETA (P50)</TH>
                  <TH>Earliest — latest</TH>
                  <TH numeric>P(on date)</TH>
                  <TH numeric>P(by date)</TH>
                  <TH>Quality</TH>
                  <TH>Shipment</TH>
                  <TH>Readiness</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={8}>No units.</EmptyRow>
                ) : (
                  rows.map((r) => (
                    <TR key={r.unit_id}>
                      <RowHeader>
                        <Link className="code text-accent hover:underline" to={`/delivery/units/${r.unit_id}`}>{r.asset_code}</Link>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">{r.item_code}</span>
                      </RowHeader>
                      <TD><DateText value={r.eta_p50} /></TD>
                      <TD className="whitespace-nowrap"><DateText value={r.earliest} /> — <DateText value={r.latest} /></TD>
                      <TD numeric>{r.p_on_date !== null ? `${Math.round(Number(r.p_on_date) * 100)}%` : '—'}</TD>
                      <TD numeric>{r.p_by_date !== null ? `${Math.round(Number(r.p_by_date) * 100)}%` : '—'}</TD>
                      <TD>
                        <StateBadge state={r.quality} />
                        {r.unknown_reason ? <span className="mt-0.5 block max-w-[200px] text-[11px] text-muted-foreground">{r.unknown_reason}</span> : null}
                      </TD>
                      <TD>{r.shipment_code ? <span className="code">{r.shipment_code}</span> : <span className="text-muted-foreground">—</span>}</TD>
                      <TD>
                        {r.receiving_readiness ? (
                          r.receiving_readiness.ready ? (
                            <span className="text-xs text-success">Ready{r.receiving_readiness.site_store ? ` at ${r.receiving_readiness.site_store}` : ''}</span>
                          ) : (
                            <span className="text-xs text-warning">
                              {(r.receiving_readiness.blockers ?? []).map((b) => (typeof b === 'string' ? b : b.message ?? b.code)).filter(Boolean).join('; ') || 'Blocked'}
                            </span>
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>
    </>
  )
}
