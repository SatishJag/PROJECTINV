import { CircleDollarSign, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { assets, costs } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { CostEvent, PhysicalUnit } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { DateText, EmptyState, Money, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'
import { todayISO } from '@/lib/format'

export function CostEvents() {
  const s = useSession()
  const c = useAppContext()
  const [unitFilter, setUnitFilter] = useState('')
  const [open, setOpen] = useState(false)

  const q = useApi(['costs', 'events', unitFilter || 'ALL'], costs.events(unitFilter || undefined))
  const units = useApi(['delivery', 'units', 'costs'], assets.units({ programme_id: c.programmeId ?? null }), { staleTime: 60_000, enabled: open || !!unitFilter })
  const unitList = useMemo(() => asList<PhysicalUnit>(units.data), [units.data])
  const events = asList<CostEvent>(q.data)

  const byStatus = useMemo(() => {
    const m: Record<string, number> = {}
    for (const e of events) m[e.status] = (m[e.status] ?? 0) + 1
    return m
  }, [events])

  const [key, setKey] = useState('')
  const [category, setCategory] = useState('PURCHASE')
  const [status, setStatus] = useState('ACTUAL')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [sourceSystem, setSourceSystem] = useState('MANUAL')
  const [sourceRef, setSourceRef] = useState('')
  const [unitId, setUnitId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [autoAllocate, setAutoAllocate] = useState(true)

  const reset = () => {
    setKey('')
    setAmount('')
    setSourceRef('')
    setUnitId('')
    setProjectId('')
    setAutoAllocate(true)
  }

  const record = useCommand({
    run: () =>
      costs.recordEvent({
        economic_key: key.trim(),
        category: category.trim().toUpperCase(),
        status,
        amount: amount.trim(),
        currency: currency.trim().toUpperCase().slice(0, 3),
        occurred_on: occurredOn,
        source_system: sourceSystem,
        source_ref: sourceRef.trim(),
        unit_id: unitId || null,
        posting_project_id: projectId || null,
        auto_allocate_to_unit: autoAllocate && !!unitId,
      }),
    invalidate: [['costs']],
    success: 'Cost event recorded',
    onSuccess: () => {
      setOpen(false)
      reset()
    },
  })

  return (
    <>
      <PageHeader
        eyebrow="Cost intelligence"
        title="Cost events"
        description="Every cost is recognized, provisional or superseded against a stable economic key. Revisions supersede; they never overwrite history."
        actions={
          s.can('cost.record') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus aria-hidden /> Record cost
            </Button>
          ) : null
        }
      />

      <Section
        title={`${events.length} cost event${events.length === 1 ? '' : 's'}`}
        description={`${byStatus.ACTUAL ?? 0} actual · ${byStatus.PROVISIONAL ?? 0} provisional · ${byStatus.SUPERSEDED ?? 0} superseded`}
        actions={
          <Select className="w-56" value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)} aria-label="Filter by unit">
            <option value="">All units</option>
            {unitList.map((u) => <option key={u.id} value={u.id}>{u.asset_code}</option>)}
          </Select>
        }
      >
        <QueryView q={q} rows={7} empty={<EmptyState icon={<CircleDollarSign />} title="No cost events" message="Costs arrive from Oracle, Planon, recovery cases or manual finance entries." />}>
          {() => (
            <Table caption="Cost events">
              <THead>
                <TR>
                  <TH>Economic key</TH>
                  <TH>Category</TH>
                  <TH>Status</TH>
                  <TH>Unit</TH>
                  <TH>Occurred</TH>
                  <TH>Source</TH>
                  <TH numeric>Amount</TH>
                  <TH numeric>Allocations</TH>
                </TR>
              </THead>
              <TBody>
                {events.length === 0 ? (
                  <EmptyRow cols={8}>No cost events for this filter.</EmptyRow>
                ) : (
                  events.map((e) => (
                    <TR key={e.id}>
                      <RowHeader>
                        <span className="code">{e.economic_key}</span>
                        {e.revision_no > 1 ? <span className="ml-1 text-[11px] text-muted-foreground">rev {e.revision_no}</span> : null}
                      </RowHeader>
                      <TD>{humanize(e.category)}</TD>
                      <TD><StateBadge state={e.status} /></TD>
                      <TD>{e.asset_code ? <span className="code">{e.asset_code}</span> : <span className="text-muted-foreground">—</span>}</TD>
                      <TD><DateText value={e.occurred_on} /></TD>
                      <TD>
                        <span className="text-xs">{e.source_system}</span>
                        <span className="block text-[11px] text-muted-foreground">{e.source_ref}</span>
                      </TD>
                      <TD numeric><Money value={e.amount} currency={e.currency} /></TD>
                      <TD numeric>{e.allocations?.length ?? 0}</TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Record cost event"
        description="An economic key identifies the same cost across source revisions. Use the source reference for the external document."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={record.isPending} disabled={!key.trim() || !amount.trim() || !sourceRef.trim()} onClick={() => record.mutate()}>
              Record event
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Economic key" required hint="Stable across revisions, for example ORACLE:PO:PO-1001:LINE:1:FREIGHT.">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="MANUAL:2026:0007" />
            </Field>
            <Field label="Source reference" required>
              <Input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="Invoice or journal reference" />
            </Field>
            <Field label="Category" required>
              <Input value={category} onChange={(e) => setCategory(e.target.value.toUpperCase())} placeholder="PURCHASE" />
            </Field>
            <Field label="Status" required>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ACTUAL">Actual (recognized)</option>
                <option value="PROVISIONAL">Provisional (not recognized)</option>
              </Select>
            </Field>
            <Field label="Amount" required>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1250.00" />
            </Field>
            <Field label="Currency" required>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
            </Field>
            <Field label="Occurred on" required>
              <Input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
            </Field>
            <Field label="Source system">
              <Select value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)}>
                <option value="MANUAL">Manual</option>
                <option value="ORACLE">Oracle</option>
                <option value="PLANON">Planon</option>
                <option value="PROCORE">Procore</option>
              </Select>
            </Field>
            <Field label="Unit" hint="Attach to an asset to make the cost visible on its passport.">
              <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">No unit</option>
                {unitList.map((u) => <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'}</option>)}
              </Select>
            </Field>
            <Field label="Posting project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
              </Select>
            </Field>
          </div>
          <Checkbox
            checked={autoAllocate}
            onChange={(e) => setAutoAllocate(e.target.checked)}
            disabled={!unitId}
            label="Allocate the full amount to the unit's project at the occurrence date"
          />
        </div>
      </Dialog>
    </>
  )
}
