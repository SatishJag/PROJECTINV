import { ArrowLeftRight, Plus, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { assets, inventory, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { PhysicalUnit, TransferManifest } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { CommandDialog } from '@/components/CommandDialog'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, Mono, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList } from '@/lib/utils'

export function Transfers() {
  const s = useSession()
  const c = useAppContext()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [projectId, setProjectId] = useState(c.projectId ?? '')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState<{ manifest: TransferManifest; action: 'approve' | 'dispatch' | 'receive' } | null>(null)

  const q = useApi(['delivery', 'transfers'], inventory.transfers)
  const locations = useApi(['ref', 'locations'], reference.locations, { staleTime: 10 * 60_000 })
  const units = useApi(['delivery', 'units', 'transfer'], assets.units({ programme_id: c.programmeId ?? null }), { enabled: open })
  const unitList = useMemo(() => asList<PhysicalUnit>(units.data).filter((u) => !['CANCELLED', 'SCRAPPED', 'RETIRED'].includes(u.state)), [units.data])
  const selected = Object.entries(picked).filter(([, v]) => v).map(([k]) => k)

  const create = useCommand({
    run: () =>
      inventory.createTransfer({
        code: code.trim(),
        from_location_id: fromId,
        to_location_id: toId,
        to_project_id: projectId || null,
        unit_ids: selected,
      }),
    invalidate: [['delivery']],
    success: (m) => `Transfer ${m.code} drafted with ${m.unit_ids.length} units`,
    onSuccess: () => {
      setOpen(false)
      setCode('')
      setPicked({})
    },
  })
  const act = useCommand({
    run: (v: { id: string; action: 'approve' | 'dispatch' | 'receive'; unitIds: string[] }) =>
      v.action === 'approve'
        ? inventory.approveTransfer(v.id)
        : v.action === 'dispatch'
          ? inventory.dispatchTransfer(v.id)
          : inventory.receiveTransfer(v.id, v.unitIds),
    invalidate: [['delivery']],
    success: 'Transfer updated',
    onSuccess: () => setTarget(null),
  })

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Transfers"
        description="Move an entire structure between custody locations. The structure hash proves nothing changed in transit."
        actions={
          s.can('transfer.manage') ? (
            <Button variant="primary" onClick={() => { setPicked({}); setOpen(true) }}>
              <Plus aria-hidden /> New transfer
            </Button>
          ) : null
        }
      />

      <Section title={`${asList<TransferManifest>(q.data).length} transfer${asList<TransferManifest>(q.data).length === 1 ? '' : 's'}`} description="Approve freezes the structure; dispatch checks the hash; receive confirms per-unit arrival.">
        <QueryView q={q} rows={6} empty={<EmptyState icon={<Truck />} title="No transfers" message="Create a transfer to move equipment between warehouse, site store or supplier." />}>
          {() => (
            <Table caption="Transfer manifests">
              <THead>
                <TR>
                  <TH>Transfer</TH>
                  <TH>State</TH>
                  <TH>From</TH>
                  <TH>To</TH>
                  <TH numeric>Units</TH>
                  <TH numeric>Received</TH>
                  <TH>Structure hash</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {asList<TransferManifest>(q.data).length === 0 ? (
                  <EmptyRow cols={8}>No transfer manifests.</EmptyRow>
                ) : (
                  asList<TransferManifest>(q.data).map((m) => {
                    const from = locations.data?.find((l) => l.id === m.from_location_id)
                    const to = locations.data?.find((l) => l.id === m.to_location_id)
                    return (
                      <TR key={m.id}>
                        <RowHeader><span className="code">{m.code}</span></RowHeader>
                        <TD><StateBadge state={m.state} /></TD>
                        <TD>{from?.code ?? m.from_location_id.slice(0, 8)}</TD>
                        <TD>{to?.code ?? m.to_location_id.slice(0, 8)}</TD>
                        <TD numeric>{m.unit_ids.length}</TD>
                        <TD numeric>{m.received_unit_ids?.length ?? 0}</TD>
                        <TD><Mono className="text-[11px]">{m.structure_hash}</Mono></TD>
                        <TD className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            {m.state === 'DRAFT' && s.can('transfer.approve') ? (
                              <Button size="sm" onClick={() => setTarget({ manifest: m, action: 'approve' })}>Approve</Button>
                            ) : null}
                            {m.state === 'APPROVED' && s.can('transfer.manage') ? (
                              <Button size="sm" onClick={() => setTarget({ manifest: m, action: 'dispatch' })}>Dispatch</Button>
                            ) : null}
                            {m.state === 'IN_TRANSIT' && s.can('transfer.manage') ? (
                              <Button size="sm" variant="primary" onClick={() => setTarget({ manifest: m, action: 'receive' })}>Receive</Button>
                            ) : null}
                          </div>
                        </TD>
                      </TR>
                    )
                  })
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New transfer"
        description="Selected units and their fitted components move together. Components cannot be separated from their parent in transit."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!code.trim() || !fromId || !toId || !selected.length} onClick={() => create.mutate()}>
              Draft transfer
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Transfer code" required>
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="TRF-2026-0042" />
            </Field>
            <Field label="Destination project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project (warehouse move)</option>
                {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
              </Select>
            </Field>
            <Field label="From location" required>
              <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                <option value="">Select origin</option>
                {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.kind.replace('_', ' ')}</option>)}
              </Select>
            </Field>
            <Field label="To location" required>
              <Select value={toId} onChange={(e) => setToId(e.target.value)}>
                <option value="">Select destination</option>
                {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.kind.replace('_', ' ')}</option>)}
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Units</p>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {units.isPending ? <p className="p-2 text-xs text-muted-foreground">Loading units…</p> : unitList.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No units.</p> : unitList.map((u) => (
                <div key={u.id} className="rounded px-2 py-1 hover:bg-muted">
                  <Checkbox
                    checked={!!picked[u.id]}
                    onChange={(e) => setPicked({ ...picked, [u.id]: e.target.checked })}
                    label={<span><span className="code">{u.asset_code}</span><span className="ml-2 text-[11px] text-muted-foreground">{u.item_code} · {u.state.replace('_', ' ')}</span></span>}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Dialog>

      <CommandDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title={target?.action === 'approve' ? 'Approve transfer' : target?.action === 'dispatch' ? 'Dispatch transfer' : 'Receive transfer'}
        description={
          target?.action === 'dispatch'
            ? 'Dispatch re-hashes the structure; if a component changed since approval the command is rejected.'
            : target?.action === 'receive'
              ? 'Confirms every unit as received at the destination. Partial receipts are not offered.'
              : 'Approval freezes the manifest contents for dispatch.'
        }
        confirmLabel={target?.action === 'approve' ? 'Approve' : target?.action === 'dispatch' ? 'Dispatch' : 'Receive all'}
        run={() => (target ? act.mutateAsync({ id: target.manifest.id, action: target.action, unitIds: target.manifest.unit_ids }) : Promise.resolve(undefined))}
        invalidate={[['delivery']]}
        success={target?.action === 'receive' ? 'Units received' : 'Transfer updated'}
      >
        {target ? (
          <div className="space-y-2">
            <p className="text-[13px]"><span className="code">{target.manifest.code}</span> · {target.manifest.unit_ids.length} units</p>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
              {target.manifest.unit_ids.slice(0, 30).map((id) => <li key={id}><Mono>{id.slice(0, 8)}</Mono></li>)}
            </ul>
            <p className="text-[11px] text-muted-foreground">Structure hash <Mono>{target.manifest.structure_hash}</Mono></p>
            {target.action === 'receive' ? <p className="text-[11px] text-muted-foreground">Received {target.manifest.received_unit_ids?.length ?? 0} of {target.manifest.unit_ids.length}.</p> : null}
            <p className="text-[11px] text-muted-foreground"><ArrowLeftRight className="mr-1 inline size-3" aria-hidden /> {new Date(target.manifest.created_at ?? '').toLocaleString()}</p>
          </div>
        ) : null}
      </CommandDialog>

      <div className="mt-4 text-right">
        <DateTimeText value={null} unknownLabel="Last refreshed when the page loaded" />
      </div>
    </>
  )
}
