import { ArrowLeft, ClipboardCheck, MapPin, Wrench } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { assets, inventory, quality, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { StructureNode } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import {
  Callout,
  DateText,
  DateTimeText,
  EmptyState,
  IdentityBand,
  KV,
  Money,
  Mono,
  PageHeader,
  Qty,
  QueryView,
  Section,
  StateBadge,
} from '@/components/common'
import { cn } from '@/lib/utils'

export function UnitDetail() {
  const { unitId = '' } = useParams()
  const s = useSession()
  const c = useAppContext()
  const q = useApi(['delivery', 'unit', unitId], assets.unit(unitId))
  const history = useApi(['delivery', 'unit-history', unitId], assets.history(unitId), { staleTime: 30_000 })
  const locations = useApi(['ref', 'locations'], reference.locations, { staleTime: 10 * 60_000 })
  const [tab, setTab] = useState('overview')
  const [allocOpen, setAllocOpen] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [alloc, setAlloc] = useState({ kind: 'PLANNING_INTENT', project_id: '', reason: '' })
  const [issue, setIssue] = useState({ to_location_id: '', installed_position: '' })
  const [test, setTest] = useState({ test_type: 'FAT', test_ref: '', result: 'PASS', stage: 'SUPPLIER_FACTORY', measurement: '' })

  const allocate = useCommand({
    run: () => inventory.allocate({ unit_ids: [unitId], kind: alloc.kind, to_project_id: alloc.project_id, reason: alloc.reason.trim() }),
    invalidate: [['delivery']],
    success: 'Allocation recorded',
    onSuccess: () => setAllocOpen(false),
  })
  const issueUnit = useCommand({
    run: () => inventory.issue({ unit_id: unitId, to_location_id: issue.to_location_id, installed_position: issue.installed_position || null }),
    invalidate: [['delivery']],
    success: 'Unit issued to site; Oracle posting queued',
    onSuccess: () => setIssueOpen(false),
  })
  const recordTest = useCommand({
    run: () => quality.recordTest({ unit_id: unitId, ...test, performed_at: new Date().toISOString() }),
    invalidate: [['delivery']],
    success: 'Test recorded',
    onSuccess: () => setTestOpen(false),
  })

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/delivery/units" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3" aria-hidden /> Units</Link>}
        title={q.data ? q.data.unit.asset_code : 'Unit passport'}
        description="The single evidence-backed record for custody, configuration, tests, cost and integrations."
        actions={
          q.data ? (
            <>
              {s.can('allocation.manage') ? (
                <Button
                  onClick={() => {
                    setAlloc({ kind: 'PLANNING_INTENT', project_id: q.data?.unit.assigned_project_id ?? c.projectId ?? '', reason: '' })
                    setAllocOpen(true)
                  }}
                >
                  <MapPin aria-hidden /> Allocate
                </Button>
              ) : null}
              {s.can('issue.create') ? (
                <Button
                  onClick={() => {
                    setIssue({ to_location_id: locations.data?.find((l) => l.kind === 'SITE_STORE')?.id ?? '', installed_position: q.data?.unit.installed_position ?? '' })
                    setIssueOpen(true)
                  }}
                >
                  <Wrench aria-hidden /> Issue
                </Button>
              ) : null}
              {s.can('test.record') ? (
                <Button onClick={() => setTestOpen(true)}>
                  <ClipboardCheck aria-hidden /> Record test
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <QueryView q={q} rows={6}>
        {(p) => (
          <>
            <IdentityBand
              items={[
                { label: 'Asset', value: p.unit.asset_code },
                { label: 'Item', value: p.unit.item_code ?? '—' },
                { label: 'State', value: <StateBadge state={p.unit.state} /> },
                { label: 'Allocation', value: <StateBadge state={p.unit.allocation_status} context="allocation" /> },
                { label: 'Custody', value: p.custody_location?.code ?? '—' },
                { label: 'Project', value: p.assigned_project?.code ?? '—' },
              ]}
              right={<Mono className="text-[11px] text-ink-muted">{p.unit.id}</Mono>}
            />

            {p.recovery_cases.some((r) => r.state !== 'CLOSED') ? (
              <Callout tone="danger" title="Open recovery case" className="mb-4" actions={<Button size="sm" onClick={() => setTab('tests')}>Review tests</Button>}>
                This unit has an open non-conformance. It cannot be accepted into a handbook until the case is released.
              </Callout>
            ) : null}

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList aria-label="Unit passport sections">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="structure">Configuration</TabsTrigger>
                <TabsTrigger value="tests">Quality & recovery ({p.tests.length})</TabsTrigger>
                <TabsTrigger value="cost">Cost</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="integration">Integration</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <div className="grid gap-4 lg:grid-cols-3">
                  <Section title="Asset facts" className="lg:col-span-2">
                    <div className="p-4">
                      <KV
                        cols={3}
                        items={[
                          { label: 'Manufacturer', value: p.item_model?.manufacturer ?? '—' },
                          { label: 'Model', value: p.item_model?.model ?? '—' },
                          { label: 'Rated capacity', value: p.item_model?.rated_capacity ? <Qty value={p.item_model.rated_capacity} uom={p.item_model.capacity_unit} /> : '—' },
                          { label: 'Serial number', value: <Mono>{p.unit.serial_number}</Mono> },
                          { label: 'Barcode', value: <Mono>{p.unit.barcode}</Mono> },
                          { label: 'Condition', value: <StateBadge state={p.unit.condition} /> },
                          { label: 'Quality status', value: <StateBadge state={p.unit.quality_status} /> },
                          { label: 'Installed position', value: p.unit.installed_position || '—' },
                          { label: 'Parent', value: p.parent ? <Link className="text-accent hover:underline" to={`/delivery/units/${p.parent.unit.id}`}>{p.parent.unit.asset_code} · {p.parent.slot_code}</Link> : '—' },
                          { label: 'Warranty start', value: <DateText value={p.unit.warranty_start} /> },
                          { label: 'Warranty end', value: <DateText value={p.unit.warranty_end} /> },
                          { label: 'In service', value: <DateText value={p.unit.in_service_date} /> },
                        ]}
                      />
                    </div>
                  </Section>
                  <Section title="Origin & assignment">
                    <div className="p-4">
                      <KV
                        cols={2}
                        items={[
                          { label: 'Requirement', value: p.requirement ? <Link className="code text-accent hover:underline" to={`/planning/requirements/${p.requirement.id}`}>{p.requirement.code}</Link> : '—' },
                          { label: 'Purchase order', value: p.po ? <Mono>{p.po.canonical_number}</Mono> : '—' },
                          { label: 'Project', value: p.assigned_project?.name ?? '—' },
                          { label: 'Custody', value: p.custody_location?.name ?? '—' },
                          { label: 'Handbook', value: p.handbook ? <Link className="text-accent hover:underline" to={`/handbook/packages/${p.handbook.package_id}`}><StateBadge state={p.handbook.state} /></Link> : <span className="text-muted-foreground">Not started</span> },
                          { label: 'Arrival quality', value: p.latest_arrival ? <StateBadge state={String(p.latest_arrival.quality)} /> : '—' },
                        ]}
                      />
                    </div>
                  </Section>
                  <Section title="Latest arrival forecast" description="As known at the evidence cutoff; never overwritten by a later feed." className="lg:col-span-3">
                    <div className="p-4">
                      {p.latest_arrival ? (
                        <KV
                          cols={4}
                          items={[
                            { label: 'ETA (P50)', value: <DateText value={p.latest_arrival.eta_p50} /> },
                            { label: 'Earliest', value: <DateText value={p.latest_arrival.earliest} /> },
                            { label: 'Latest', value: <DateText value={p.latest_arrival.latest} /> },
                            { label: 'Quality', value: <StateBadge state={String(p.latest_arrival.quality)} /> },
                            { label: 'Recorded', value: <DateTimeText value={p.latest_arrival.recorded_at} /> },
                            { label: 'Evidence cutoff', value: <DateTimeText value={p.latest_arrival.evidence_cutoff} /> },
                            { label: 'Unknown reason', value: p.latest_arrival.unknown_reason || '—' },
                          ]}
                        />
                      ) : (
                        <EmptyState title="No arrival snapshot" message="Create a snapshot on the Arrival board to record the forecast as known today." />
                      )}
                    </div>
                  </Section>
                </div>
              </TabsContent>

              <TabsContent value="structure">
                <Section title="Configuration structure" description="Component hierarchy with effective dates; historic structure is preserved.">
                  <div className="p-4">
                    <StructureTree node={p.structure} />
                  </div>
                </Section>
              </TabsContent>

              <TabsContent value="tests">
                <div className="space-y-4">
                  <Section title="Tests" description="Passing FAT and commissioning tests feed handbook evidence." actions={s.can('test.record') ? <Button size="sm" onClick={() => setTestOpen(true)}>Record test</Button> : null}>
                    <Table caption="Test records">
                      <THead>
                        <TR>
                          <TH>Stage</TH>
                          <TH>Type</TH>
                          <TH>Reference</TH>
                          <TH>Result</TH>
                          <TH>Measurement</TH>
                          <TH>Performed</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {p.tests.length === 0 ? (
                          <EmptyRow cols={6}>No test recorded.</EmptyRow>
                        ) : (
                          p.tests.map((t) => (
                            <TR key={t.id}>
                              <RowHeader>{t.stage.replace(/_/g, ' ')}</RowHeader>
                              <TD>{t.test_type}</TD>
                              <TD><Mono>{t.test_ref}</Mono></TD>
                              <TD><StateBadge state={t.result} /></TD>
                              <TD>{t.measurement ?? '—'}</TD>
                              <TD><DateTimeText value={t.performed_at} /></TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                  <Section title="Recovery cases" description="Non-conformances and their disposition route.">
                    <Table caption="Recovery cases">
                      <THead>
                        <TR>
                          <TH>NCR</TH>
                          <TH>State</TH>
                          <TH>Route</TH>
                          <TH>Stage</TH>
                          <TH>Replacement ETA</TH>
                          <TH>Impact</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {p.recovery_cases.length === 0 ? (
                          <EmptyRow cols={6}>No recovery case.</EmptyRow>
                        ) : (
                          p.recovery_cases.map((r) => (
                            <TR key={r.id}>
                              <RowHeader><Link className="code text-accent hover:underline" to={`/delivery/recovery/${r.id}`}>{r.ncr_number}</Link></RowHeader>
                              <TD><StateBadge state={r.state} /></TD>
                              <TD>{r.route?.replace(/_/g, ' ') ?? '—'}</TD>
                              <TD>{r.failure_stage.replace(/_/g, ' ')}</TD>
                              <TD><DateText value={r.replacement_eta} /></TD>
                              <TD className="max-w-[280px] text-xs">{(r.impacts_json ?? []).map((i) => i.impact).filter(Boolean).join(' · ') || '—'}</TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                </div>
              </TabsContent>

              <TabsContent value="cost">
                {p.cost_summary ? (
                  <div className="space-y-4">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg border bg-card px-4 py-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Recognized</p>
                        <p className="mt-1 text-xl font-semibold"><Money value={p.cost_summary.recognized_total} currency={p.cost_summary.currency} /></p>
                      </div>
                      <div className="rounded-lg border bg-card px-4 py-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Provisional</p>
                        <p className="mt-1 text-xl font-semibold"><Money value={p.cost_summary.provisional_total} currency={p.cost_summary.currency} /></p>
                      </div>
                      <div className="rounded-lg border bg-card px-4 py-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Unallocated</p>
                        <p className="mt-1 text-xl font-semibold"><Money value={p.cost_summary.unallocated_total} currency={p.cost_summary.currency} /></p>
                      </div>
                    </div>
                    <Section title="Cost by category">
                      <Table caption="Cost by category">
                        <THead>
                          <TR><TH>Category</TH><TH numeric>Recognized</TH><TH numeric>Provisional</TH></TR>
                        </THead>
                        <TBody>
                          {p.cost_summary.by_category.length === 0 ? <EmptyRow cols={3}>No cost events attributed.</EmptyRow> : p.cost_summary.by_category.map((x) => (
                            <TR key={x.category}>
                              <RowHeader>{x.category.replace(/_/g, ' ')}</RowHeader>
                              <TD numeric><Money value={x.recognized} currency={p.cost_summary?.currency} /></TD>
                              <TD numeric><Money value={x.provisional} currency={p.cost_summary?.currency} /></TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </Section>
                    <Section title="Cost sources" description="One row per economic event; revisions supersede rather than overwrite.">
                      <Table caption="Cost sources">
                        <THead>
                          <TR><TH>Source</TH><TH>Reference</TH><TH>Category</TH><TH>Status</TH><TH numeric>Amount</TH><TH>Occurred</TH></TR>
                        </THead>
                        <TBody>
                          {p.cost_summary.sources.length === 0 ? <EmptyRow cols={6}>No sources.</EmptyRow> : p.cost_summary.sources.map((src, i) => (
                            <TR key={src.cost_event_id ?? i}>
                              <RowHeader>{src.source_system ?? '—'}</RowHeader>
                              <TD><Mono>{src.source_ref}</Mono></TD>
                              <TD>{src.category ?? '—'}</TD>
                              <TD><StateBadge state={src.status} /></TD>
                              <TD numeric><Money value={src.amount} currency={src.currency} /></TD>
                              <TD><DateText value={src.occurred_on} /></TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </Section>
                  </div>
                ) : (
                  <EmptyState title="Commercial values restricted" message="Your role cannot view cost evidence for this asset." />
                )}
              </TabsContent>

              <TabsContent value="history">
                <QueryView q={history} rows={5}>
                  {(h) => (
                    <div className="space-y-4">
                      <Section title="Allocations">
                        <Table caption="Allocation history">
                          <THead>
                            <TR><TH>Kind</TH><TH>State</TH><TH>From project</TH><TH>To project</TH><TH>Reason</TH><TH>Effective</TH></TR>
                          </THead>
                          <TBody>
                            {(h.allocations ?? []).length === 0 ? <EmptyRow cols={6}>No allocation.</EmptyRow> : (h.allocations ?? []).map((a) => (
                              <TR key={a.id}>
                                <RowHeader>{a.kind.replace(/_/g, ' ')}</RowHeader>
                                <TD><StateBadge state={a.state} /></TD>
                                <TD>{a.from_project_id ? c.projectCode(a.from_project_id) ?? a.from_project_id.slice(0, 8) : '—'}</TD>
                                <TD>{a.to_project_id ? c.projectCode(a.to_project_id) ?? a.to_project_id.slice(0, 8) : '—'}</TD>
                                <TD className="max-w-[280px] text-xs">{a.reason ?? '—'}</TD>
                                <TD><DateTimeText value={a.effective_from} /></TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </Section>
                      <Section title="Stock transactions" description="Mirrored Oracle movements, with confirmation state.">
                        <Table caption="Stock transactions">
                          <THead>
                            <TR><TH>Type</TH><TH>From</TH><TH>To</TH><TH>State</TH><TH>Oracle ref</TH><TH>Confirmed</TH></TR>
                          </THead>
                          <TBody>
                            {(h.stock_transactions ?? []).length === 0 ? <EmptyRow cols={6}>No stock movement.</EmptyRow> : (h.stock_transactions ?? []).map((t) => (
                              <TR key={t.id}>
                                <RowHeader>{t.txn_type}</RowHeader>
                                <TD>{t.from_location_id ? locations.data?.find((l) => l.id === t.from_location_id)?.code ?? '—' : '—'}</TD>
                                <TD>{t.to_location_id ? locations.data?.find((l) => l.id === t.to_location_id)?.code ?? '—' : '—'}</TD>
                                <TD><StateBadge state={t.state} /></TD>
                                <TD><Mono>{t.oracle_txn_id}</Mono></TD>
                                <TD><DateTimeText value={t.confirmed_at} /></TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </Section>
                      <Section title="Component changes">
                        <Table caption="Component history">
                          <THead>
                            <TR><TH>Slot</TH><TH>Child asset</TH><TH>Installed</TH><TH>Removed</TH><TH>Reason</TH></TR>
                          </THead>
                          <TBody>
                            {(h.components ?? []).length === 0 ? <EmptyRow cols={5}>No component changes.</EmptyRow> : (h.components ?? []).map((x) => (
                              <TR key={x.id}>
                                <RowHeader>{x.slot_code}</RowHeader>
                                <TD><Link className="code text-accent hover:underline" to={`/delivery/units/${x.child_unit_id}`}>{x.child_asset_code ?? x.child_unit_id.slice(0, 8)}</Link></TD>
                                <TD><DateTimeText value={x.valid_from} /></TD>
                                <TD><DateTimeText value={x.valid_to} /></TD>
                                <TD className="max-w-[280px] text-xs">{x.removal_reason ?? x.install_reason ?? '—'}</TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </Section>
                      <Section title="Audit trail">
                        <Table caption="Unit audit trail">
                          <THead>
                            <TR><TH>When</TH><TH>Actor</TH><TH>Action</TH><TH>Reason</TH></TR>
                          </THead>
                          <TBody>
                            {(h.audit ?? []).length === 0 ? <EmptyRow cols={4}>No audit events.</EmptyRow> : (h.audit ?? []).map((a) => (
                              <TR key={a.id}>
                                <RowHeader><DateTimeText value={a.at} /></RowHeader>
                                <TD>{a.actor}</TD>
                                <TD><span className="code">{a.action}</span></TD>
                                <TD className="max-w-[320px] text-xs">{a.reason ?? '—'}</TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </Section>
                    </div>
                  )}
                </QueryView>
              </TabsContent>

              <TabsContent value="integration">
                <Section title="External links" description="Procore equipment objects and other platform mappings for this unit.">
                  <Table caption="External links">
                    <THead>
                      <TR><TH>Platform</TH><TH>Object</TH><TH>Link role</TH><TH>Sync state</TH><TH>Last synced</TH></TR>
                    </THead>
                    <TBody>
                      {p.external_links.length === 0 ? <EmptyRow cols={5}>No external link. A Procore sync creates one when the equipment object exists.</EmptyRow> : p.external_links.map((l) => (
                        <TR key={l.id}>
                          <RowHeader>{l.platform}</RowHeader>
                          <TD><span className="code">{l.object_type}:{l.object_key}</span></TD>
                          <TD>{l.link_role}</TD>
                          <TD><StateBadge state={l.sync_state} /></TD>
                          <TD><DateTimeText value={l.last_synced_at} /></TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  <div className="border-t p-4">
                    <KV
                      cols={3}
                      items={[
                        { label: 'Oracle serial ref', value: <Mono>{p.unit.oracle_serial_ref}</Mono> },
                        { label: 'Planon asset id', value: <Mono>{p.unit.planon_asset_id}</Mono> },
                        { label: 'Procore equipment id', value: <Mono>{p.unit.procore_equipment_id}</Mono> },
                      ]}
                    />
                  </div>
                </Section>
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryView>

      <Dialog
        open={allocOpen}
        onOpenChange={setAllocOpen}
        title="Allocate unit"
        description="Planning intent confirms immediately. Oracle reservations and project transfers queue an integration command."
        footer={
          <>
            <Button onClick={() => setAllocOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={allocate.isPending} disabled={!alloc.project_id || !alloc.reason.trim()} onClick={() => allocate.mutate()}>
              Allocate
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Allocation kind" required>
            <Select value={alloc.kind} onChange={(e) => setAlloc({ ...alloc, kind: e.target.value })}>
              <option value="PLANNING_INTENT">Planning intent</option>
              <option value="ORACLE_RESERVATION">Oracle reservation</option>
              <option value="PROJECT_TRANSFER">Project transfer (chargeable)</option>
            </Select>
          </Field>
          <Field label="Destination project" required>
            <Select value={alloc.project_id} onChange={(e) => setAlloc({ ...alloc, project_id: e.target.value })}>
              <option value="">Select project</option>
              {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </Select>
          </Field>
          <Field label="Reason" required className="sm:col-span-2">
            <Textarea value={alloc.reason} onChange={(e) => setAlloc({ ...alloc, reason: e.target.value })} placeholder="Allocated for BKK2 chiller plant installation" />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title="Issue unit to site"
        description="Updates custody and queues the Oracle stock issue and Procore equipment upsert."
        footer={
          <>
            <Button onClick={() => setIssueOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={issueUnit.isPending} disabled={!issue.to_location_id} onClick={() => issueUnit.mutate()}>
              Issue unit
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Issue location" required>
            <Select value={issue.to_location_id} onChange={(e) => setIssue({ ...issue, to_location_id: e.target.value })}>
              <option value="">Select site store</option>
              {(locations.data ?? []).filter((l) => l.kind === 'SITE_STORE' || l.kind === 'INSTALLED').map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Installed position">
            <Input value={issue.installed_position} onChange={(e) => setIssue({ ...issue, installed_position: e.target.value })} placeholder="Level 2 plant room, CH-02" />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={testOpen}
        onOpenChange={setTestOpen}
        title="Record test"
        description="A failed test opens a recovery case or places the unit on hold; passing evidence feeds the handbook."
        footer={
          <>
            <Button onClick={() => setTestOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={recordTest.isPending} disabled={!test.test_ref.trim()} onClick={() => recordTest.mutate()}>
              Record test
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Test type" required>
            <Select value={test.test_type} onChange={(e) => setTest({ ...test, test_type: e.target.value })}>
              {['FAT', 'SAT', 'RETEST', 'COMMISSIONING'].map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </Field>
          <Field label="Result" required>
            <Select value={test.result} onChange={(e) => setTest({ ...test, result: e.target.value })}>
              <option value="PASS">Pass</option>
              <option value="FAIL">Fail</option>
            </Select>
          </Field>
          <Field label="Test reference" required>
            <Input value={test.test_ref} onChange={(e) => setTest({ ...test, test_ref: e.target.value })} placeholder="FAT-2027-0142" />
          </Field>
          <Field label="Stage">
            <Select value={test.stage} onChange={(e) => setTest({ ...test, stage: e.target.value })}>
              {['SUPPLIER_FACTORY', 'SITE_RECEIPT', 'COMMISSIONING'].map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Measurement / observation" className="sm:col-span-2">
            <Input value={test.measurement} onChange={(e) => setTest({ ...test, measurement: e.target.value })} placeholder="COP deviation +2.1%, within tolerance" />
          </Field>
        </div>
      </Dialog>
    </>
  )
}

function StructureTree({ node }: { node: StructureNode | StructureNode[] | null }) {
  if (!node) return <p className="text-[13px] text-muted-foreground">No configuration structure recorded.</p>
  const list = Array.isArray(node) ? node : [node]
  return (
    <ul className={cn('space-y-1', 'text-[13px]')}>
      {list.map((n, i) => {
        const unit = n.unit ?? (n.asset_code ? (n as StructureNode) : null)
        const children = n.children ?? []
        return (
          <li key={(unit?.id ?? n.link_id ?? `${i}`) + i}>
            <div className="flex flex-wrap items-center gap-2">
              {n.slot_code ? <span className="code rounded bg-muted px-1 py-0.5 text-[10px]">{n.slot_code}</span> : null}
              {unit ? (
                <Link className="code text-accent hover:underline" to={`/delivery/units/${unit.id}`}>{unit.asset_code}</Link>
              ) : null}
              {unit?.item_code ? <span className="text-[11px] text-muted-foreground">{unit.item_code}</span> : null}
              {n.vacant ? <StateBadge state="MISSING" /> : null}
              {unit?.state ? <StateBadge state={unit.state} /> : null}
            </div>
            {children.length ? <div className="ml-4 border-l pl-3 pt-1"><StructureTree node={children} /></div> : null}
          </li>
        )
      })}
    </ul>
  )
}
