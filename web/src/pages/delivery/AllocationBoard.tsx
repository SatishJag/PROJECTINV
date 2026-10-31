import { ArrowRightLeft, MapPin } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { assets, inventory, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { AllocationRecord, PhysicalUnit } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList } from '@/lib/utils'

export function AllocationBoard() {
  const s = useSession()
  const c = useAppContext()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [kind, setKind] = useState('PLANNING_INTENT')
  const [projectId, setProjectId] = useState(c.projectId ?? '')
  const [wbsId, setWbsId] = useState('')
  const [reason, setReason] = useState('')

  const q = useApi(['delivery', 'allocations'], inventory.allocations())
  const units = useApi(['delivery', 'units', 'allocatable'], assets.units({ programme_id: c.programmeId ?? null }), { enabled: open })
  const wbs = useApi(['ref', 'wbs', projectId], reference.wbs(projectId), { enabled: !!projectId, staleTime: 5 * 60_000 })

  const allocatable = useMemo(() => asList<PhysicalUnit>(units.data).filter((u) => !['CANCELLED', 'SCRAPPED', 'RETIRED'].includes(u.state) && u.state !== 'ISSUED'), [units.data])
  const selected = Object.entries(picked).filter(([, v]) => v).map(([k]) => k)

  const allocate = useCommand({
    run: () =>
      inventory.allocate({
        unit_ids: selected,
        kind,
        to_project_id: projectId,
        to_wbs_id: wbsId || null,
        reason: reason.trim(),
      }),
    invalidate: [['delivery'], ['planning']],
    success: (r) => `${r.allocations.length} allocation(s) recorded for ${r.to_project.code}`,
    onSuccess: () => {
      setOpen(false)
      setPicked({})
      setReason('')
    },
  })
  const release = useCommand({
    run: (id: string) => inventory.releaseAllocation(id),
    invalidate: [['delivery']],
    success: 'Allocation released',
  })

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Allocation board"
        description="Planning intent, Oracle reservations and chargeable project transfers — each with its own confirmation state."
        actions={
          s.can('allocation.manage') ? (
            <Button variant="primary" onClick={() => { setPicked({}); setOpen(true) }}>
              <MapPin aria-hidden /> Allocate units
            </Button>
          ) : null
        }
      />

      <Section title={`${asList<AllocationRecord>(q.data).length} allocation${asList<AllocationRecord>(q.data).length === 1 ? '' : 's'}`} description="Superseded allocations remain visible for audit.">
        <QueryView q={q} rows={6} empty={<EmptyState icon={<ArrowRightLeft />} title="No allocations" message="Allocate received units to a project to plan installation." />}>
          {() => (
            <Table caption="Allocations">
              <THead>
                <TR>
                  <TH>Unit</TH>
                  <TH>Kind</TH>
                  <TH>State</TH>
                  <TH>From → to</TH>
                  <TH>WBS</TH>
                  <TH>Reason</TH>
                  <TH>Charge</TH>
                  <TH>Effective</TH>
                  <TH className="text-right">Action</TH>
                </TR>
              </THead>
              <TBody>
                {asList<AllocationRecord>(q.data).length === 0 ? (
                  <EmptyRow cols={9}>No allocation recorded.</EmptyRow>
                ) : (
                  asList<AllocationRecord>(q.data).map((a) => (
                    <TR key={a.id}>
                      <RowHeader><Link className="code text-accent hover:underline" to={`/delivery/units/${a.unit_id}`}>{a.unit_id.slice(0, 8)}</Link></RowHeader>
                      <TD>{a.kind.replace(/_/g, ' ')}</TD>
                      <TD><StateBadge state={a.state} /></TD>
                      <TD className="whitespace-nowrap">{a.from_project_id ? c.projectCode(a.from_project_id) ?? '—' : '—'} → {a.to_project_id ? c.projectCode(a.to_project_id) ?? '—' : '—'}</TD>
                      <TD>{a.to_wbs_id ? <span className="code">{a.to_wbs_id.slice(0, 8)}</span> : '—'}</TD>
                      <TD className="max-w-[260px] text-xs">{a.reason ?? '—'}</TD>
                      <TD>{a.generates_project_charge ? <StateBadge state="ACTUAL" /> : <span className="text-xs text-muted-foreground">No</span>}</TD>
                      <TD><DateTimeText value={a.effective_from} /></TD>
                      <TD className="text-right">
                        {(a.state === 'PENDING' || a.state === 'CONFIRMED') && s.can('allocation.manage') ? (
                          <Button size="sm" loading={release.isPending && release.variables === a.id} onClick={() => release.mutate(a.id)}>
                            Release
                          </Button>
                        ) : null}
                      </TD>
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
        title="Allocate units"
        description="A unit has one live allocation. A new allocation supersedes the prior one."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={allocate.isPending} disabled={!selected.length || !projectId || !reason.trim()} onClick={() => allocate.mutate()}>
              Allocate {selected.length || ''} unit{selected.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" required>
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="PLANNING_INTENT">Planning intent — confirms immediately</option>
                <option value="ORACLE_RESERVATION">Oracle reservation — waits for Oracle</option>
                <option value="PROJECT_TRANSFER">Project transfer — chargeable</option>
              </Select>
            </Field>
            <Field label="Destination project" required>
              <Select value={projectId} onChange={(e) => { setProjectId(e.target.value); setWbsId('') }}>
                <option value="">Select project</option>
                {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </Select>
            </Field>
            <Field label="WBS element">
              <Select value={wbsId} onChange={(e) => setWbsId(e.target.value)} disabled={!wbsId && !wbs.data?.length}>
                <option value="">Default project WBS</option>
                {(wbs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
              </Select>
            </Field>
            <Field label="Reason" required>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reserved for BKK2 installation programme" />
            </Field>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium">Units</p>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {units.isPending ? <p className="p-2 text-xs text-muted-foreground">Loading units…</p> : allocatable.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No allocatable units.</p> : allocatable.map((u) => (
                <div key={u.id} className="rounded px-2 py-1 hover:bg-muted">
                  <Checkbox
                    checked={!!picked[u.id]}
                    onChange={(e) => setPicked({ ...picked, [u.id]: e.target.checked })}
                    label={
                      <span>
                        <span className="code">{u.asset_code}</span>
                        <span className="ml-2 text-[12px]">{u.item_code}</span>
                        <span className="ml-2 text-[11px] text-muted-foreground">{u.state.replace('_', ' ')} · {u.custody_code ?? 'no custody'}</span>
                      </span>
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Dialog>
    </>
  )
}
