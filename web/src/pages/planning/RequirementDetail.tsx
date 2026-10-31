import { ArrowLeft, BarChart3, ClipboardList, Plus, RotateCcw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { planning } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { BenchmarkRunResponse, RequirementRevision } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
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
  Unknown,
} from '@/components/common'
import { formatMoney } from '@/lib/format'
import { cn, humanize } from '@/lib/utils'

interface RevDraft {
  quantity: string
  duty: string
  capacity: string
  capacity_unit: string
  redundancy: string
  cost_code: string
  budget_amount: string
  required_site_date: string
  required_install_date: string
  change_reason: string
}

export function RequirementDetail() {
  const { requirementId = '' } = useParams()
  const s = useSession()
  const q = useApi(['planning', 'requirement', requirementId], planning.requirement(requirementId))
  const d = q.data
  const [tab, setTab] = useState('overview')
  const [reviseOpen, setReviseOpen] = useState(false)
  const [rev, setRev] = useState<RevDraft>({ quantity: '1', duty: '', capacity: '', capacity_unit: '', redundancy: '', cost_code: '', budget_amount: '', required_site_date: '', required_install_date: '', change_reason: '' })
  const [benchmark, setBenchmark] = useState<BenchmarkRunResponse | null>(null)
  const [assessOpen, setAssessOpen] = useState(false)
  const [assess, setAssess] = useState({ unit_id: '', transfer_cost: '0', refurbishment_cost: '0', retest_cost: '0', forward_new_cost: '', available_from: '' })

  const latest = d?.latest_revision ?? null
  const current = d?.current_revision ?? null
  const approved = d?.revisions.find((r) => r.state === 'APPROVED') ?? (current?.state === 'APPROVED' ? current : null)
  const reuseRevision = approved ?? latest

  const candidates = useApi(
    ['planning', 'reuse-candidates', reuseRevision?.id ?? 'none'],
    planning.reuseCandidates(reuseRevision?.id ?? ''),
    { enabled: !!reuseRevision, staleTime: 30_000 },
  )

  const submit = useCommand({
    run: (id: string) => planning.submitRevision(id),
    invalidate: [['planning']],
    success: 'Revision submitted for review',
  })
  const approve = useCommand({
    run: (id: string) => planning.approveRevision(id, { ifMatch: d?.etag ?? null }),
    invalidate: [['planning']],
    success: 'Revision approved',
  })
  const cancel = useCommand({
    run: (id: string) => planning.cancelRevision(id),
    invalidate: [['planning']],
    success: 'Revision cancelled',
  })
  const revise = useCommand({
    run: () =>
      planning.revise(
        requirementId,
        {
          changes: {
            quantity: rev.quantity,
            duty: rev.duty || null,
            capacity: rev.capacity || null,
            capacity_unit: rev.capacity_unit || null,
            redundancy: rev.redundancy || null,
            cost_code: rev.cost_code || null,
            budget_amount: rev.budget_amount || null,
            required_site_date: rev.required_site_date || null,
            required_install_date: rev.required_install_date || null,
          },
          change_reason: rev.change_reason.trim(),
        },
        {},
      ),
    invalidate: [['planning']],
    success: 'New revision created',
    onSuccess: () => setReviseOpen(false),
  })
  const runBenchmark = useCommand({
    run: (revisionId: string) => planning.runBenchmark({ requirement_revision_id: revisionId }),
    invalidate: [['planning']],
    success: 'Benchmark calculated',
    onSuccess: (r) => setBenchmark(r),
  })
  const createAssessment = useCommand({
    run: () =>
      planning.createReuseAssessment({
        requirement_revision_id: reuseRevision?.id,
        unit_id: assess.unit_id,
        transfer_cost: assess.transfer_cost || '0',
        refurbishment_cost: assess.refurbishment_cost || '0',
        retest_cost: assess.retest_cost || '0',
        forward_new_cost: assess.forward_new_cost || '0',
        available_from: assess.available_from || null,
      }),
    invalidate: [['planning']],
    success: 'Reuse assessment recorded',
    onSuccess: () => setAssessOpen(false),
  })
  const release = useCommand({
    run: (id: string) => planning.releaseReservation(id),
    invalidate: [['planning']],
    success: 'Reservation released',
  })
  const resolveImpact = useCommand({
    run: (v: { id: string; resolution: string }) => planning.resolveImpact(v.id, v.resolution),
    invalidate: [['planning']],
    success: 'Impact action resolved',
  })

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/planning/requirements" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="size-3" aria-hidden /> Requirements
          </Link>
        }
        title={d ? `${d.code} · ${d.title}` : 'Requirement'}
        description="Technical basis, revision history and the evidence behind its sourcing route."
        actions={
          d ? (
            <>
              {latest && latest.state === 'DRAFT' && s.can('requirement.edit') ? (
                <Button onClick={() => submit.mutate(latest.id)} loading={submit.isPending}>
                  <ShieldCheck aria-hidden /> Submit revision {latest.revision_no}
                </Button>
              ) : null}
              {(latest?.state === 'IN_REVIEW' || latest?.state === 'DRAFT') && s.can('requirement.approve') ? (
                <Button variant="primary" onClick={() => approve.mutate(latest.id)} loading={approve.isPending}>
                  <ShieldCheck aria-hidden /> Approve revision {latest.revision_no}
                </Button>
              ) : null}
              {s.can('requirement.edit') ? (
                <Button
                  onClick={() => {
                    const r = latest ?? current
                    setRev({
                      quantity: r?.quantity ?? '1',
                      duty: r?.duty ?? '',
                      capacity: r?.capacity ?? '',
                      capacity_unit: r?.capacity_unit ?? '',
                      redundancy: r?.redundancy ?? '',
                      cost_code: r?.cost_code ?? '',
                      budget_amount: r?.budget_amount ?? '',
                      required_site_date: r?.required_site_date ?? '',
                      required_install_date: r?.required_install_date ?? '',
                      change_reason: '',
                    })
                    setReviseOpen(true)
                  }}
                >
                  <Plus aria-hidden /> New revision
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <QueryView q={q} rows={5}>
        {(data) => {
          return (
            <>
              <IdentityBand
                items={[
                  { label: 'Requirement', value: data.code },
                  { label: 'Project', value: data.project_code ?? '—' },
                  { label: 'Class', value: data.equipment_class_name ?? data.equipment_class_code ?? '—' },
                  { label: 'Route', value: <StateBadge state={data.sourcing_route} /> },
                  { label: 'State', value: <StateBadge state={data.state} /> },
                  { label: 'Approved revision', value: data.current_revision ? `Rev ${data.current_revision.revision_no}` : <Unknown label="Not approved" /> },
                ]}
                right={<Mono className="text-[11px] text-ink-muted">{data.id}</Mono>}
              />

              {data.current_revision && data.latest_revision && data.current_revision.id !== data.latest_revision.id ? (
                <Callout tone="warning" title={`Revision ${data.latest_revision.revision_no} is ${humanize(data.latest_revision.state).toLowerCase()}`} className="mb-4">
                  Approval will supersede revision {data.current_revision.revision_no} and open impact actions for any downstream records that used it.
                </Callout>
              ) : null}

              <Tabs value={tab} onValueChange={setTab}>
                <TabsList aria-label="Requirement sections">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="revisions">Revisions ({data.revisions.length})</TabsTrigger>
                  <TabsTrigger value="impact">Impact actions ({data.impact_actions.filter((a) => a.state === 'OPEN').length})</TabsTrigger>
                  <TabsTrigger value="benchmarks">Benchmarks ({data.benchmark_runs.length})</TabsTrigger>
                  <TabsTrigger value="reuse">Reuse</TabsTrigger>
                  <TabsTrigger value="reservations">Reservations ({data.reservations.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="overview">
                  <div className="grid gap-4 lg:grid-cols-3">
                    <Section title="Approved technical basis" description="The values sourcing and handbooks quote." className="lg:col-span-2">
                      <div className="p-4">
                        {data.current_revision ? (
                          <KV
                            cols={3}
                            items={[
                              { label: 'Quantity', value: <Qty value={data.current_revision.quantity} uom={data.current_revision.uom} /> },
                              { label: 'Duty', value: data.current_revision.duty || <Unknown label="Not specified" /> },
                              { label: 'Capacity', value: data.current_revision.capacity ? <Qty value={data.current_revision.capacity} uom={data.current_revision.capacity_unit} /> : <Unknown label="Not specified" /> },
                              { label: 'Redundancy', value: data.current_revision.redundancy || <Unknown label="Not specified" /> },
                              { label: 'Cost code', value: <Mono>{data.current_revision.cost_code}</Mono> },
                              { label: 'Budget', value: <Money value={data.current_revision.budget_amount} currency={data.current_revision.currency} /> },
                              { label: 'Required on site', value: <DateText value={data.current_revision.required_site_date} /> },
                              { label: 'Required installation', value: <DateText value={data.current_revision.required_install_date} /> },
                              { label: 'Approved', value: <DateTimeText value={data.current_revision.approved_at} /> },
                            ]}
                          />
                        ) : (
                          <EmptyState icon={<ClipboardList />} title="No approved revision" message="Submit and approve a revision to publish the technical basis." />
                        )}
                      </div>
                    </Section>
                    <Section title="Governing records">
                      <div className="p-4">
                        <KV
                          cols={2}
                          items={[
                            { label: 'Project', value: data.project_name ?? data.project_code ?? '—' },
                            { label: 'Equipment class', value: data.equipment_class_code ?? '—' },
                            { label: 'Source BOQ', value: <Mono>{data.source_boq_key ?? 'Direct entry'}</Mono> },
                            { label: 'Reservations', value: data.reservations.length },
                            { label: 'Benchmark runs', value: data.benchmark_runs.length },
                            { label: 'Reuse assessments', value: data.reuse_assessments.length },
                          ]}
                        />
                      </div>
                    </Section>
                  </div>
                </TabsContent>

                <TabsContent value="revisions">
                  <Section
                    title="Revision history"
                    description="Every revision keeps its change reason and approver."
                    actions={
                      s.can('requirement.edit') ? (
                        <Button size="sm" onClick={() => setReviseOpen(true)}>
                          <Plus aria-hidden /> New revision
                        </Button>
                      ) : null
                    }
                  >
                    <Table caption="Requirement revisions">
                      <THead>
                        <TR>
                          <TH>Rev</TH>
                          <TH>State</TH>
                          <TH numeric>Quantity</TH>
                          <TH>Duty / capacity</TH>
                          <TH>Change reason</TH>
                          <TH>Submitted</TH>
                          <TH>Approved</TH>
                          <TH className="text-right">Actions</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {data.revisions.length === 0 ? (
                          <EmptyRow cols={8}>No revisions.</EmptyRow>
                        ) : (
                          [...data.revisions]
                            .sort((a, b) => b.revision_no - a.revision_no)
                            .map((r) => (
                              <TR key={r.id}>
                                <RowHeader>Rev {r.revision_no}</RowHeader>
                                <TD><StateBadge state={r.state} /></TD>
                                <TD numeric><Qty value={r.quantity} uom={r.uom} /></TD>
                                <TD>{[r.duty, r.capacity && `${r.capacity} ${r.capacity_unit ?? ''}`].filter(Boolean).join(' · ') || '—'}</TD>
                                <TD className="max-w-[240px]">{r.change_reason || (r.revision_no === 1 ? 'Initial issue' : '—')}</TD>
                                <TD><DateTimeText value={r.submitted_at} /></TD>
                                <TD><DateTimeText value={r.approved_at} /></TD>
                                <TD className="text-right">
                                  <RevisionActions
                                    r={r}
                                    canEdit={s.can('requirement.edit')}
                                    canApprove={s.can('requirement.approve')}
                                    busy={submit.isPending || approve.isPending || cancel.isPending}
                                    onSubmit={() => submit.mutate(r.id)}
                                    onApprove={() => approve.mutate(r.id)}
                                    onCancel={() => cancel.mutate(r.id)}
                                  />
                                </TD>
                              </TR>
                            ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                </TabsContent>

                <TabsContent value="impact">
                  <Section title="Impact actions" description="Records that must be reviewed when the requirement basis changes.">
                    <Table caption="Impact actions">
                      <THead>
                        <TR>
                          <TH>Subject</TH>
                          <TH>Reason</TH>
                          <TH>Owner</TH>
                          <TH>State</TH>
                          <TH>Resolution</TH>
                          <TH className="text-right">Action</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {data.impact_actions.length === 0 ? (
                          <EmptyRow cols={6}>No impact actions opened by revisions.</EmptyRow>
                        ) : (
                          data.impact_actions.map((a) => (
                            <TR key={a.id}>
                              <RowHeader>
                                <span className="code">{a.subject_type}</span>
                                <span className="mt-0.5 block text-[11px] text-muted-foreground">{a.subject_id.slice(0, 8)}</span>
                              </RowHeader>
                              <TD className="max-w-[320px]">{a.reason}</TD>
                              <TD>{humanize(a.owner_role)}</TD>
                              <TD><StateBadge state={a.state} /></TD>
                              <TD className="max-w-[220px]">{a.resolution || '—'}</TD>
                              <TD className="text-right">
                                {a.state === 'OPEN' ? (
                                  <Button
                                    size="sm"
                                    loading={resolveImpact.isPending && resolveImpact.variables?.id === a.id}
                                    onClick={() => {
                                      const resolution = window.prompt('Resolution for the audit trail')
                                      if (resolution?.trim()) resolveImpact.mutate({ id: a.id, resolution: resolution.trim() })
                                    }}
                                  >
                                    Resolve
                                  </Button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Resolved</span>
                                )}
                              </TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                </TabsContent>

                <TabsContent value="benchmarks">
                  <div className="space-y-4">
                    <Section
                      title="Benchmark runs"
                      description="Comparable, normalized cost evidence. Insufficient evidence is reported, never estimated."
                      actions={
                        s.can('benchmark.run') && reuseRevision ? (
                          <Button size="sm" variant="primary" loading={runBenchmark.isPending} onClick={() => runBenchmark.mutate(reuseRevision.id)}>
                            <BarChart3 aria-hidden /> Run benchmark
                          </Button>
                        ) : null
                      }
                    >
                      <Table caption="Benchmark runs">
                        <THead>
                          <TR>
                            <TH>Run</TH>
                            <TH>Revision</TH>
                            <TH>State</TH>
                            <TH numeric>Samples</TH>
                            <TH>Evidence cutoff</TH>
                            <TH>Quality</TH>
                            <TH numeric>Median</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {data.benchmark_runs.length === 0 ? (
                            <EmptyRow cols={7}>No benchmark has been calculated for this requirement.</EmptyRow>
                          ) : (
                            data.benchmark_runs.map((b) => {
                              const results = b.results ?? []
                              const median = results.find((x) => x.metric_code.toLowerCase().includes('installed') || x.metric_code.toLowerCase().includes('cost')) ?? results[0]
                              return (
                                <TR key={b.id}>
                                  <RowHeader><Mono>{b.id}</Mono><span className="mt-0.5 block text-[11px] text-muted-foreground"><DateTimeText value={b.created_at} /></span></RowHeader>
                                  <TD><Mono>{b.requirement_revision_id.slice(0, 8)}</Mono></TD>
                                  <TD><StateBadge state={b.state} /></TD>
                                  <TD numeric>{b.sample_count}</TD>
                                  <TD><DateTimeText value={b.evidence_cutoff} /></TD>
                                  <TD className="max-w-[220px] text-xs text-muted-foreground">{String(b.quality_json?.coverage ?? b.quality_json?.basis ?? '—')}</TD>
                                  <TD numeric>{median ? <Money value={median.value_median} currency={median.unit ?? undefined} /> : '—'}</TD>
                                </TR>
                              )
                            })
                          )}
                        </TBody>
                      </Table>
                    </Section>

                    {benchmark ? (
                      <Section title="Latest run result" description={`${benchmark.results.length} metrics · ${benchmark.run.sample_count} observations · ${humanize(benchmark.run.state)}`}>
                        <Table caption="Benchmark metrics">
                          <THead>
                            <TR>
                              <TH>Metric</TH>
                              <TH>Basis</TH>
                              <TH numeric>Min</TH>
                              <TH numeric>Median</TH>
                              <TH numeric>Max</TH>
                              <TH numeric>Samples</TH>
                              <TH>Coverage note</TH>
                            </TR>
                          </THead>
                          <TBody>
                            {benchmark.results.map((m) => (
                              <TR key={m.id}>
                                <RowHeader>{humanize(m.metric_code)}</RowHeader>
                                <TD>{humanize(m.basis)}</TD>
                                <TD numeric><Money value={m.value_min} /></TD>
                                <TD numeric><Money value={m.value_median} /></TD>
                                <TD numeric><Money value={m.value_max} /></TD>
                                <TD numeric>{m.sample_count}</TD>
                                <TD className="max-w-[240px] text-xs text-muted-foreground">{m.coverage_note ?? '—'}</TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                        {benchmark.excluded.length ? (
                          <div className="border-t p-3">
                            <p className="text-xs font-semibold text-muted-foreground">Excluded observations</p>
                            <ul className="mt-1 space-y-1 text-xs">
                              {benchmark.excluded.slice(0, 5).map((x, i) => (
                                <li key={i}>
                                  {x.source_project_code ?? x.observation_id} — {x.reason ?? (x.reasons ?? []).join('; ')}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </Section>
                    ) : null}
                  </div>
                </TabsContent>

                <TabsContent value="reuse">
                  <div className="space-y-4">
                    <Callout tone="info" title="Reuse before new purchase">
                      Suitability compares forward reuse cost (transfer, refurbishment, retest) with the cost of new supply. Sunk cost is excluded.
                    </Callout>
                    <Section
                      title="Reusable units in the programme"
                      description={reuseRevision ? `Candidates for revision ${reuseRevision.revision_no}` : 'Approve a revision to assess reuse.'}
                      actions={
                        reuseRevision && s.can('reuse.assess') ? (
                          <Button size="sm" onClick={() => setAssessOpen(true)} disabled={!candidates.data?.length}>
                            <Plus aria-hidden /> Assess a unit
                          </Button>
                        ) : null
                      }
                    >
                      <QueryView q={candidates} rows={4} empty={<EmptyState title="No reusable units" message="No received or returned unit of this equipment class is available in the programme." />}>
                        {(list) => (
                          <Table caption="Reuse candidates">
                            <THead>
                              <TR>
                                <TH>Asset</TH>
                                <TH>Condition</TH>
                                <TH>Custody</TH>
                                <TH>Available from</TH>
                                <TH>Reservation</TH>
                                <TH numeric>Purchase cost</TH>
                              </TR>
                            </THead>
                            <TBody>
                              {list.length === 0 ? (
                                <EmptyRow cols={6}>No candidates.</EmptyRow>
                              ) : (
                                list.map((u) => (
                                  <TR key={u.unit.id}>
                                    <RowHeader><Link className="code text-accent hover:underline" to={`/delivery/units/${u.unit.id}`}>{u.unit.asset_code}</Link><span className="mt-0.5 block text-[11px] text-muted-foreground">{u.unit.item_code}</span></RowHeader>
                                    <TD><StateBadge state={u.condition} /></TD>
                                    <TD>{u.custody_code ?? '—'}</TD>
                                    <TD><DateText value={u.available_from} /></TD>
                                    <TD>{u.active_reservation ? <StateBadge state={u.active_reservation.state} /> : <span className="text-muted-foreground">None</span>}</TD>
                                    <TD numeric><Money value={u.purchase_cost} /></TD>
                                  </TR>
                                ))
                              )}
                            </TBody>
                          </Table>
                        )}
                      </QueryView>
                    </Section>

                    <Section title="Assessments" description="Recorded suitability decisions for this requirement.">
                      <Table caption="Reuse assessments">
                        <THead>
                          <TR>
                            <TH>Unit</TH>
                            <TH>State</TH>
                            <TH numeric>Forward reuse</TH>
                            <TH numeric>New supply</TH>
                            <TH>Reservation</TH>
                            <TH>Decision</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {data.reuse_assessments.length === 0 ? (
                            <EmptyRow cols={6}>No reuse assessment recorded.</EmptyRow>
                          ) : (
                            data.reuse_assessments.map((a) => {
                              const reuse = Number(a.forward_reuse_cost ?? 0)
                              const fresh = Number(a.forward_new_cost ?? 0)
                              const saving = formatMoney(String(fresh - reuse), a.currency)
                              return (
                                <TR key={a.id}>
                                  <RowHeader><Mono>{a.unit_id.slice(0, 8)}</Mono></RowHeader>
                                  <TD><StateBadge state={a.state} /></TD>
                                  <TD numeric><Money value={a.forward_reuse_cost} currency={a.currency} /></TD>
                                  <TD numeric><Money value={a.forward_new_cost} currency={a.currency} /></TD>
                                  <TD>{a.reservation_id ? <Mono>{a.reservation_id.slice(0, 8)}</Mono> : '—'}</TD>
                                  <TD className="max-w-[220px] text-xs">{a.decision_reason ?? (saving ? `Saving vs new: ${saving}` : '—')}</TD>
                                </TR>
                              )
                            })
                          )}
                        </TBody>
                      </Table>
                    </Section>
                  </div>
                </TabsContent>

                <TabsContent value="reservations">
                  <Section title="Reservations" description="Planning holds on reusable units.">
                    <Table caption="Reservations">
                      <THead>
                        <TR>
                          <TH>Unit</TH>
                          <TH>State</TH>
                          <TH>Authority</TH>
                          <TH>Expires</TH>
                          <TH>Oracle ref</TH>
                          <TH className="text-right">Action</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {data.reservations.length === 0 ? (
                          <EmptyRow cols={6}>No reservation for this requirement.</EmptyRow>
                        ) : (
                          data.reservations.map((x) => (
                            <TR key={x.id}>
                              <RowHeader><Link className="code text-accent hover:underline" to={`/delivery/units/${x.unit_id}`}>{x.unit_id.slice(0, 8)}</Link></RowHeader>
                              <TD><StateBadge state={x.state} /></TD>
                              <TD>{humanize(x.authority)}</TD>
                              <TD><DateTimeText value={x.expires_at} /></TD>
                              <TD><Mono>{x.oracle_reservation_ref}</Mono></TD>
                              <TD className="text-right">
                                {x.state === 'ACTIVE' ? (
                                  <Button size="sm" loading={release.isPending && release.variables === x.id} onClick={() => release.mutate(x.id)}>
                                    <RotateCcw aria-hidden /> Release
                                  </Button>
                                ) : null}
                              </TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                </TabsContent>
              </Tabs>

              <Dialog
                open={reviseOpen}
                onOpenChange={setReviseOpen}
                title="New revision"
                description="Only changed fields are recorded; the previous revision stays auditable."
                size="lg"
                footer={
                  <>
                    <Button onClick={() => setReviseOpen(false)}>Cancel</Button>
                    <Button variant="primary" loading={revise.isPending} disabled={!rev.change_reason.trim() || !rev.quantity} onClick={() => revise.mutate()}>
                      Create revision
                    </Button>
                  </>
                }
              >
                <div className={cn('grid gap-3 sm:grid-cols-2')}>
                  <Field label="Quantity" required>
                    <Input inputMode="decimal" value={rev.quantity} onChange={(e) => setRev({ ...rev, quantity: e.target.value })} />
                  </Field>
                  <Field label="Duty">
                    <Input value={rev.duty} onChange={(e) => setRev({ ...rev, duty: e.target.value })} />
                  </Field>
                  <Field label="Capacity">
                    <div className="flex gap-1.5">
                      <Input inputMode="decimal" value={rev.capacity} onChange={(e) => setRev({ ...rev, capacity: e.target.value })} />
                      <Input className="w-20" value={rev.capacity_unit} onChange={(e) => setRev({ ...rev, capacity_unit: e.target.value })} aria-label="Capacity unit" />
                    </div>
                  </Field>
                  <Field label="Redundancy">
                    <Input value={rev.redundancy} onChange={(e) => setRev({ ...rev, redundancy: e.target.value })} />
                  </Field>
                  <Field label="Cost code">
                    <Input value={rev.cost_code} onChange={(e) => setRev({ ...rev, cost_code: e.target.value })} />
                  </Field>
                  <Field label="Budget amount">
                    <Input inputMode="decimal" value={rev.budget_amount} onChange={(e) => setRev({ ...rev, budget_amount: e.target.value })} />
                  </Field>
                  <Field label="Required on site">
                    <Input type="date" value={rev.required_site_date} onChange={(e) => setRev({ ...rev, required_site_date: e.target.value })} />
                  </Field>
                  <Field label="Required installation">
                    <Input type="date" value={rev.required_install_date} onChange={(e) => setRev({ ...rev, required_install_date: e.target.value })} />
                  </Field>
                  <Field label="Change reason" required className="sm:col-span-2">
                    <Textarea value={rev.change_reason} onChange={(e) => setRev({ ...rev, change_reason: e.target.value })} placeholder="Why the requirement basis is changing" />
                  </Field>
                </div>
              </Dialog>

              <Dialog
                open={assessOpen}
                onOpenChange={setAssessOpen}
                title="Assess reuse"
                description="Compares forward reuse cost with new supply and records the cheaper, defensible route."
                footer={
                  <>
                    <Button onClick={() => setAssessOpen(false)}>Cancel</Button>
                    <Button variant="primary" loading={createAssessment.isPending} disabled={!assess.unit_id || !assess.forward_new_cost} onClick={() => createAssessment.mutate()}>
                      Record assessment
                    </Button>
                  </>
                }
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Unit" required className="sm:col-span-2">
                    <Select value={assess.unit_id} onChange={(e) => setAssess({ ...assess, unit_id: e.target.value })}>
                      <option value="">Select candidate</option>
                      {(candidates.data ?? []).map((u) => (
                        <option key={u.unit.id} value={u.unit.id}>
                          {u.unit.asset_code} · {u.condition ?? 'Condition unknown'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Transfer cost" required>
                    <Input inputMode="decimal" value={assess.transfer_cost} onChange={(e) => setAssess({ ...assess, transfer_cost: e.target.value })} />
                  </Field>
                  <Field label="Refurbishment cost" required>
                    <Input inputMode="decimal" value={assess.refurbishment_cost} onChange={(e) => setAssess({ ...assess, refurbishment_cost: e.target.value })} />
                  </Field>
                  <Field label="Retest cost" required>
                    <Input inputMode="decimal" value={assess.retest_cost} onChange={(e) => setAssess({ ...assess, retest_cost: e.target.value })} />
                  </Field>
                  <Field label="Forward new cost" required>
                    <Input inputMode="decimal" value={assess.forward_new_cost} onChange={(e) => setAssess({ ...assess, forward_new_cost: e.target.value })} />
                  </Field>
                  <Field label="Available from">
                    <Input type="date" value={assess.available_from} onChange={(e) => setAssess({ ...assess, available_from: e.target.value })} />
                  </Field>
                </div>
              </Dialog>
            </>
          )
        }}
      </QueryView>
    </>
  )
}

function RevisionActions({
  r,
  canEdit,
  canApprove,
  busy,
  onSubmit,
  onApprove,
  onCancel,
}: {
  r: RequirementRevision
  canEdit: boolean
  canApprove: boolean
  busy: boolean
  onSubmit: () => void
  onApprove: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {r.state === 'DRAFT' && canEdit ? (
        <Button size="sm" disabled={busy} onClick={onSubmit}>
          Submit
        </Button>
      ) : null}
      {(r.state === 'IN_REVIEW' || r.state === 'DRAFT') && canApprove ? (
        <Button size="sm" variant="primary" disabled={busy} onClick={onApprove}>
          Approve
        </Button>
      ) : null}
      {r.state === 'DRAFT' && canEdit ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {r.state === 'APPROVED' ? <span className="text-xs text-muted-foreground">Current basis</span> : null}
    </div>
  )
}
