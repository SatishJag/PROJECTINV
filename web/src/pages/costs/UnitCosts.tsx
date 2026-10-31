import { CircleDollarSign, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { assets, costs } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { PhysicalUnit } from '@/api/types'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/form'
import { Callout, DateText, EmptyState, ErrorPanel, LoadingBlock, Metric, Money, PageHeader, QueryView, Section, StateBadge, Unknown } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

export function UnitCosts() {
  const { unitId } = useParams()
  const navigate = useNavigate()
  const c = useAppContext()
  const [search, setSearch] = useState('')

  const units = useApi(['delivery', 'units', 'cost-picker', c.programmeId ?? 'all'], assets.units({ programme_id: c.programmeId ?? null }), { staleTime: 60_000 })
  const unitList = useMemo(() => asList<PhysicalUnit>(units.data), [units.data])
  const filtered = unitList.filter((u) => !search.trim() || `${u.asset_code} ${u.item_code ?? ''} ${u.serial_number ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))

  const q = useApi(['costs', 'unit', unitId ?? ''], costs.unitSummary(unitId ?? ''), { enabled: !!unitId })
  const d = q.data

  if (!unitId) {
    return (
      <>
        <PageHeader
          eyebrow="Cost intelligence"
          title="Unit cost summary"
          description="Recognized and provisional cost per asset, with category, project attribution and source evidence."
        />
        <Section title="Choose an asset" description="Search by asset code, model or serial.">
          <div className="border-b px-4 py-3">
            <Field label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input className="pl-7" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ASSET-0001, generator, serial" />
              </div>
            </Field>
          </div>
          <QueryView q={units} rows={6} empty={<EmptyState icon={<CircleDollarSign />} title="No assets" message="Assets appear once received against a purchase order." />}>
            {() => (
              <Table caption="Assets">
                <THead>
                  <TR>
                    <TH>Asset</TH>
                    <TH>Model</TH>
                    <TH>Serial</TH>
                    <TH>State</TH>
                    <TH>Project</TH>
                    <TH className="text-right">Costs</TH>
                  </TR>
                </THead>
                <TBody>
                  {filtered.length === 0 ? (
                    <EmptyRow cols={6}>No assets match this search.</EmptyRow>
                  ) : (
                    filtered.map((u) => (
                      <TR key={u.id}>
                        <RowHeader>
                          <Link className="code text-accent underline-offset-2 hover:underline" to={`/costs/units/${u.id}`}>{u.asset_code}</Link>
                        </RowHeader>
                        <TD>{u.item_code ?? <span className="text-muted-foreground">Unknown</span>}</TD>
                        <TD>{u.serial_number ?? <span className="text-muted-foreground">—</span>}</TD>
                        <TD><StateBadge state={u.state} /></TD>
                        <TD>{u.project_code ?? <span className="text-muted-foreground">Unassigned</span>}</TD>
                        <TD className="text-right">
                          <Link className="text-xs font-medium text-accent underline-offset-2 hover:underline" to={`/costs/units/${u.id}`}>View summary</Link>
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

  if (q.isPending) {
    return (
      <>
        <PageHeader eyebrow="Cost intelligence" title="Unit cost summary" />
        <LoadingBlock rows={8} label="Loading cost summary" />
      </>
    )
  }
  if (q.isError) {
    return (
      <>
        <PageHeader eyebrow="Cost intelligence" title="Unit cost summary" />
        <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
      </>
    )
  }
  if (!d) return null

  const currency = d.currency ?? 'USD'

  return (
    <>
      <PageHeader
        eyebrow="Cost intelligence"
        title={<span className="inline-flex items-center gap-2">Unit cost summary <span className="code text-base text-muted-foreground">{d.asset_code ?? unitId.slice(0, 8)}</span></span>}
        description="Provisionals are visible but never folded into the recognized total. Unallocated cost remains explicit."
        actions={
          <Button onClick={() => navigate('/costs/units')}>Change asset</Button>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Recognized total" value={<Money value={d.recognized_total} currency={currency} />} tone="success" hint="ACTUAL events only" />
        <Metric label="Provisional total" value={<Money value={d.provisional_total} currency={currency} />} tone="warning" hint="Not recognized" />
        <Metric label="Unallocated" value={<Money value={d.unallocated_total} currency={currency} />} tone={d.unallocated_total ? 'danger' : 'neutral'} hint="No project attribution" />
        <Metric label="Source records" value={d.sources?.length ?? 0} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="By category" description="Recognized and provisional amounts per cost category.">
          <Table caption="Cost by category">
            <THead>
              <TR>
                <TH>Category</TH>
                <TH numeric>Recognized</TH>
                <TH numeric>Provisional</TH>
              </TR>
            </THead>
            <TBody>
              {(d.by_category ?? []).length === 0 ? (
                <EmptyRow cols={3}>No cost recorded for this unit.</EmptyRow>
              ) : (
                (d.by_category ?? []).map((row) => (
                  <TR key={row.category}>
                    <RowHeader>{humanize(row.category)}</RowHeader>
                    <TD numeric><Money value={row.recognized} currency={currency} /></TD>
                    <TD numeric><Money value={row.provisional} currency={currency} /></TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Section>

        <Section title="By project" description="Attribution follows custody at the cost date for service charges.">
          <Table caption="Cost by project">
            <THead>
              <TR>
                <TH>Project</TH>
                <TH numeric>Amount</TH>
              </TR>
            </THead>
            <TBody>
              {(d.by_project ?? []).length === 0 ? (
                <EmptyRow cols={2}>No project attribution.</EmptyRow>
              ) : (
                (d.by_project ?? []).map((row, i) => (
                  <TR key={row.project_id ?? `none-${i}`}>
                    <RowHeader>{row.project_code ?? <Unknown label="No project" />}</RowHeader>
                    <TD numeric><Money value={row.amount} currency={currency} /></TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </Section>
      </div>

      <Section className="mt-4" title="Source records" description="Each amount is traceable to its source system and document.">
        <Table caption="Cost sources">
          <THead>
            <TR>
              <TH>Occurred</TH>
              <TH>Category</TH>
              <TH>Source</TH>
              <TH>Reference</TH>
              <TH>Status</TH>
              <TH numeric>Amount</TH>
            </TR>
          </THead>
          <TBody>
            {(d.sources ?? []).length === 0 ? (
              <EmptyRow cols={6}>No source records.</EmptyRow>
            ) : (
              (d.sources ?? []).map((src, i) => (
                <TR key={src.cost_event_id ?? `${src.source_ref ?? 'src'}-${i}`}>
                  <RowHeader><DateText value={src.occurred_on} /></RowHeader>
                  <TD>{humanize(src.category ?? '')}</TD>
                  <TD>{src.source_system ?? '—'}</TD>
                  <TD><span className="code">{src.source_ref ?? '—'}</span></TD>
                  <TD><StateBadge state={src.status} /></TD>
                  <TD numeric><Money value={src.amount} currency={src.currency ?? currency} /></TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </Section>

      {d.unallocated_total ? (
        <Callout className="mt-3" tone="warning" title="Unallocated cost remains open">
          Part of this asset's cost has no project attribution. Correct the allocation in Finance rather than absorbing it into a project.
        </Callout>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        Need the total across a fitted structure? Use <Link className="text-accent underline-offset-2 hover:underline" to="/costs/rollup">structure rollup</Link>.
      </p>
    </>
  )
}
