import { Plus, Radar, Ship } from 'lucide-react'
import { useState } from 'react'
import { logistics } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { Shipment } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, Mono, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const MILESTONES = ['BOOKED', 'DEPARTED_ORIGIN', 'DEPARTED_PORT', 'ARRIVED_PORT', 'CUSTOMS_CLEARED', 'INLAND_DEPARTED', 'SITE_DELIVERED']

export function Shipments() {
  const s = useSession()
  const q = useApi(['delivery', 'shipments'], logistics.shipments)
  const [selected, setSelected] = useState<string>('')
  const [msOpen, setMsOpen] = useState(false)
  const [failOpen, setFailOpen] = useState(false)
  const [ms, setMs] = useState({ code: 'DEPARTED_PORT', estimated_at: '', actual_at: '', planned_at: '', source: 'MANUAL' })
  const [failureReason, setFailureReason] = useState('')

  const shipments = asList<Shipment>(q.data)
  const current = shipments.find((x) => x.id === selected) ?? null

  const addMs = useCommand({
    run: () =>
      logistics.addMilestone(selected, {
        code: ms.code,
        planned_at: ms.planned_at ? new Date(ms.planned_at).toISOString() : null,
        estimated_at: ms.estimated_at ? new Date(ms.estimated_at).toISOString() : null,
        actual_at: ms.actual_at ? new Date(ms.actual_at).toISOString() : null,
        source: ms.source,
      }),
    invalidate: [['delivery']],
    success: 'Milestone recorded; arrival forecast recalculated',
    onSuccess: () => setMsOpen(false),
  })
  const fail = useCommand({
    run: () => logistics.trackingFailure(selected, { reason: failureReason.trim() || undefined }),
    invalidate: [['delivery']],
    success: 'Tracking marked stale — forecasts report unknown',
    onSuccess: () => setFailOpen(false),
  })

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Shipments"
        description="Milestones are append-only evidence. The arrival forecast is derived, never hand-edited."
      />

      <div className="grid gap-4 lg:grid-cols-5">
        <Section title={`${shipments.length} shipment${shipments.length === 1 ? '' : 's'}`} className="lg:col-span-2">
          <QueryView q={q} rows={6} empty={<EmptyState icon={<Ship />} title="No shipments" message="Create a shipment from a purchase order to track milestones and ETA." />}>
            {() => (
              <Table caption="Shipments">
                <THead>
                  <TR><TH>Code</TH><TH>Mode</TH><TH>State</TH><TH>Tracking</TH></TR>
                </THead>
                <TBody>
                  {shipments.length === 0 ? <EmptyRow cols={4}>No shipments.</EmptyRow> : shipments.map((x) => (
                    <TR key={x.id} selected={x.id === selected} className="cursor-pointer" onClick={() => setSelected(x.id)}>
                      <RowHeader>
                        <span className="code">{x.code}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">{x.carrier ?? 'Carrier unknown'}</span>
                      </RowHeader>
                      <TD>{x.mode}</TD>
                      <TD><StateBadge state={x.state} /></TD>
                      <TD><DateTimeText value={x.last_tracked_at} unknownLabel="No tracking" /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </QueryView>
        </Section>

        <div className="lg:col-span-3">
          {current ? (
            <Section
              title={`${current.code} · ${current.origin ?? 'Origin unknown'} → destination`}
              description={`${current.unit_ids.length} units · container ${current.container_ref ?? '—'} · BOL/AWB ${current.bol_awb ?? '—'}`}
              actions={
                <div className="flex flex-wrap gap-1.5">
                  {s.can('transfer.manage') ? (
                    <>
                      <Button size="sm" onClick={() => setMsOpen(true)}><Plus aria-hidden /> Milestone</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setFailureReason(''); setFailOpen(true) }}><Radar aria-hidden /> Tracking failure</Button>
                    </>
                  ) : null}
                </div>
              }
            >
              <Table caption="Milestones">
                <THead>
                  <TR><TH>Milestone</TH><TH>Planned</TH><TH>Estimated</TH><TH>Actual</TH><TH>Source</TH><TH>Recorded</TH></TR>
                </THead>
                <TBody>
                  {(current.milestones ?? []).length === 0 ? (
                    <EmptyRow cols={6}>No milestone recorded. Arrival quality is UNKNOWN until evidence exists.</EmptyRow>
                  ) : (
                    [...(current.milestones ?? [])].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)).map((m) => (
                      <TR key={m.id}>
                        <RowHeader>{humanize(m.code)}</RowHeader>
                        <TD><DateTimeText value={m.planned_at} /></TD>
                        <TD><DateTimeText value={m.estimated_at} /></TD>
                        <TD><DateTimeText value={m.actual_at} /></TD>
                        <TD>{m.source}</TD>
                        <TD><DateTimeText value={m.recorded_at} /></TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
              <div className="border-t p-4">
                <p className="text-xs font-semibold text-muted-foreground">Units on shipment</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {current.unit_ids.map((id) => (
                    <Mono key={id} className="rounded border px-1.5 py-0.5 text-[11px]">{id.slice(0, 8)}</Mono>
                  ))}
                  {current.unit_ids.length === 0 ? <span className="text-xs text-muted-foreground">None assigned.</span> : null}
                </div>
              </div>
            </Section>
          ) : (
            <EmptyState icon={<Ship />} title="Select a shipment" message="Choose a shipment to inspect its milestone evidence and record an update." />
          )}
        </div>
      </div>

      <Dialog
        open={msOpen}
        onOpenChange={setMsOpen}
        title="Record milestone"
        description="Recording an actual arrival updates the shipment state and every affected forecast."
        footer={
          <>
            <Button onClick={() => setMsOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={addMs.isPending} onClick={() => addMs.mutate()}>Record</Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Milestone" required>
            <Select value={ms.code} onChange={(e) => setMs({ ...ms, code: e.target.value })}>
              {MILESTONES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={ms.source} onChange={(e) => setMs({ ...ms, source: e.target.value })}>
              {['MANUAL', 'CARRIER_FEED', 'PORT_FEED'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
            </Select>
          </Field>
          <Field label="Planned">
            <Input type="datetime-local" value={ms.planned_at} onChange={(e) => setMs({ ...ms, planned_at: e.target.value })} />
          </Field>
          <Field label="Estimated">
            <Input type="datetime-local" value={ms.estimated_at} onChange={(e) => setMs({ ...ms, estimated_at: e.target.value })} />
          </Field>
          <Field label="Actual">
            <Input type="datetime-local" value={ms.actual_at} onChange={(e) => setMs({ ...ms, actual_at: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={failOpen}
        onOpenChange={setFailOpen}
        title="Record tracking failure"
        description="Clears the last tracked timestamp. Forecasts become UNKNOWN instead of silently ageing."
        footer={
          <>
            <Button onClick={() => setFailOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={fail.isPending} onClick={() => fail.mutate()}>Mark unknown</Button>
          </>
        }
      >
        <Field label="Reason">
          <Input value={failureReason} onChange={(e) => setFailureReason(e.target.value)} placeholder="Carrier feed has not delivered since 12 Oct" />
        </Field>
      </Dialog>
    </>
  )
}
