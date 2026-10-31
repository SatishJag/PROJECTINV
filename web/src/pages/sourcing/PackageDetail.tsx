import { ArrowLeft, Award, Calculator, FileInput, Plus, Send, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { reference, sourcing } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { EvaluationResultLine, OfferLine } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { CommandDialog } from '@/components/CommandDialog'
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
import { cn, humanize } from '@/lib/utils'

interface OfferLineDraft {
  option_code: string
  quantity: string
  unit_price: string
  lead_time_days: string
  promised_delivery_date: string
  annual_om_estimate: string
  warranty_months: string
}

export function PackageDetail() {
  const { packageId = '' } = useParams()
  const s = useSession()
  const pkgQ = useApi(['sourcing', 'package', packageId], sourcing.package(packageId))
  const pkg = pkgQ.data
  const [tab, setTab] = useState('overview')
  const [evalId, setEvalId] = useState('')
  const [offerId, setOfferId] = useState('')
  const [awardId, setAwardId] = useState('')
  const [issueOpen, setIssueOpen] = useState(false)
  const [calcOpen, setCalcOpen] = useState(false)
  const [offerOpen, setOfferOpen] = useState(false)
  const [awardOpen, setAwardOpen] = useState(false)
  const [weights, setWeights] = useState({ INSTALLED_COST: '0.4', TCO: '0.3', DELIVERY: '0.2', TECHNICAL: '0.1', horizon_years: '5', discount_rate: '0.08' })
  const [drafts, setDrafts] = useState<Record<string, OfferLineDraft>>({})
  const [supplierId, setSupplierId] = useState('')
  const [offerMeta, setOfferMeta] = useState({ source_offer_key: '', currency: '', incoterms: 'DAP', valid_until: '' })
  const [awardRationale, setAwardRationale] = useState('')
  const [selectedOfferLine, setSelectedOfferLine] = useState('')
  const [adjustment, setAdjustment] = useState({ category: 'INSTALL', amount: '', rationale: '' })

  const evalQ = useApi(['sourcing', 'evaluation', evalId], sourcing.evaluation(evalId), { enabled: !!evalId })
  const offerQ = useApi(['sourcing', 'offer', offerId], sourcing.offer(offerId), { enabled: !!offerId })
  const awardQ = useApi(['sourcing', 'award', awardId], sourcing.award(awardId), { enabled: !!awardId })
  const suppliers = useApi(['ref', 'suppliers'], reference.suppliers, { staleTime: 10 * 60_000 })
  const options = useApi(['ref', 'options'], reference.options, { staleTime: 10 * 60_000, enabled: offerOpen })

  const issue = useCommand({
    run: () => sourcing.issuePackage(packageId),
    invalidate: [['sourcing']],
    success: 'Package issued to invited suppliers',
  })
  const calculate = useCommand({
    run: () =>
      sourcing.calculateEvaluation(packageId, {
        criteria_policy_json: {
          weights: { INSTALLED_COST: weights.INSTALLED_COST, TCO: weights.TCO, DELIVERY: weights.DELIVERY, TECHNICAL: weights.TECHNICAL },
          horizon_years: Number(weights.horizon_years),
          discount_rate: weights.discount_rate,
        },
      }),
    invalidate: [['sourcing']],
    success: 'Evaluation calculated',
    onSuccess: (r) => {
      setEvalId(r.evaluation.id)
      setCalcOpen(false)
      setTab('evaluation')
    },
  })
  const submitEval = useCommand({
    run: (id: string) => sourcing.submitEvaluation(id, {}),
    invalidate: [['sourcing']],
    success: 'Evaluation submitted for approval',
  })
  const approveEval = useCommand({
    run: (v: { id: string; etag: string }) => sourcing.approveEvaluation(v.id, { ifMatch: v.etag }),
    invalidate: [['sourcing']],
    success: 'Evaluation approved',
  })
  const submitOffer = useCommand({
    run: () => {
      const lines = (pkg?.lines ?? [])
        .map((l) => {
          const d = drafts[l.id]
          if (!d?.option_code || !d.unit_price) return null
          return {
            line_key: l.line_key,
            option_code: d.option_code,
            quantity: d.quantity || l.quantity,
            unit_price: d.unit_price,
            promised_delivery_date: d.promised_delivery_date || null,
            lead_time_days: d.lead_time_days ? Number(d.lead_time_days) : null,
            scope_json: { included: [], excluded: [] },
            annual_om_estimate: d.annual_om_estimate || null,
            warranty_months: d.warranty_months ? Number(d.warranty_months) : null,
          }
        })
        .filter(Boolean)
      return sourcing.submitOffer(packageId, {
        supplier_id: s.isSupplier ? undefined : supplierId,
        source_offer_key: offerMeta.source_offer_key.trim(),
        currency: offerMeta.currency || pkg?.currency,
        incoterms: offerMeta.incoterms || null,
        valid_until: offerMeta.valid_until || null,
        lines,
      })
    },
    invalidate: [['sourcing']],
    success: (o) => `Offer ${o.offer.supplier_key ?? ''} revision ${o.offer.revision_no} received`,
    onSuccess: () => {
      setOfferOpen(false)
      setTab('offers')
    },
  })
  const addAdjustment = useCommand({
    run: () =>
      sourcing.addAdjustment(selectedOfferLine, {
        category: adjustment.category,
        amount: adjustment.amount,
        currency: offerQ.data?.offer.currency ?? 'USD',
        rationale: adjustment.rationale.trim(),
      }),
    invalidate: [['sourcing']],
    success: 'Adjustment proposed',
    onSuccess: () => setAdjustment({ category: 'INSTALL', amount: '', rationale: '' }),
  })
  const decideAdjustment = useCommand({
    run: (v: { id: string; approve: boolean }) => (v.approve ? sourcing.approveAdjustment(v.id) : sourcing.rejectAdjustment(v.id)),
    invalidate: [['sourcing']],
    success: 'Adjustment decided',
  })
  const createAward = useCommand({
    run: () => {
      const detail = evalQ.data
      if (!detail) throw new Error('Evaluation not loaded')
      const line = (detail.results.lines ?? []).find((x) => x.offer_id === selectedOfferLine)
      const lines = (pkg?.lines ?? [])
        .map((pl) => {
          const offerLineId = line?.offer_lines?.[pl.id]
          return offerLineId ? { package_line_id: pl.id, offer_line_id: offerLineId, selected_quantity: pl.quantity } : null
        })
        .filter((x): x is { package_line_id: string; offer_line_id: string; selected_quantity: string } => x !== null)
      return sourcing.createAward(detail.evaluation.id, {
        rationale: awardRationale.trim(),
        input_fingerprint: detail.evaluation.input_fingerprint ?? '',
        lines,
      })
    },
    invalidate: [['sourcing']],
    success: (r) => `Award ${r.award.id.slice(0, 8)} drafted`,
    onSuccess: (r) => {
      setAwardId(r.award.id)
      setAwardOpen(false)
      setTab('award')
    },
  })
  const submitAward = useCommand({
    run: (id: string) => sourcing.submitAward(id),
    invalidate: [['sourcing']],
    success: 'Award submitted for approval',
  })
  const approveAward = useCommand({
    run: (v: { id: string; etag: string; fingerprint: string }) => sourcing.approveAward(v.id, v.fingerprint, { ifMatch: v.etag }),
    invalidate: [['sourcing'], ['dashboard']],
    success: 'Award approved — purchase order released',
  })

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/sourcing/packages" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="size-3" aria-hidden /> Packages
          </Link>
        }
        title={pkg ? `${pkg.code} · ${pkg.title}` : 'Sourcing package'}
        description="Offer revisions are immutable; normalization and evaluation evidence are versioned."
        actions={
          pkg ? (
            <>
              {pkg.state === 'DRAFT' && s.can('package.manage') ? (
                <Button variant="primary" onClick={() => setIssueOpen(true)}>
                  <Send aria-hidden /> Issue package
                </Button>
              ) : null}
              {s.can('offer.submit') ? (
                <Button
                  onClick={() => {
                    const empty: Record<string, OfferLineDraft> = {}
                    for (const l of pkg.lines) empty[l.id] = { option_code: '', quantity: l.quantity, unit_price: '', lead_time_days: '', promised_delivery_date: '', annual_om_estimate: '', warranty_months: '' }
                    setDrafts(empty)
                    setOfferMeta({ source_offer_key: '', currency: pkg.currency, incoterms: 'DAP', valid_until: '' })
                    setSupplierId('')
                    setOfferOpen(true)
                  }}
                >
                  <FileInput aria-hidden /> Submit offer
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <QueryView q={pkgQ} rows={5}>
        {(data) => (
          <>
            <IdentityBand
              items={[
                { label: 'Package', value: data.code },
                { label: 'State', value: <StateBadge state={data.state} /> },
                { label: 'Currency', value: data.currency },
                { label: 'Lines', value: data.lines.length },
                { label: 'Offers', value: data.offers.length },
                { label: 'Bid due', value: <DateTimeText value={data.bid_due_at} /> },
              ]}
              right={<Mono className="text-[11px] text-ink-muted">{data.id}</Mono>}
            />

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList aria-label="Package sections">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="offers">Offers ({data.offers.length})</TabsTrigger>
                <TabsTrigger value="evaluation">Evaluation ({data.evaluations.length})</TabsTrigger>
                <TabsTrigger value="award">Award ({data.awards.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="overview">
                <div className="grid gap-4 lg:grid-cols-3">
                  <Section title="Package lines" description="Each line is pinned to an approved requirement revision." className="lg:col-span-2">
                    <Table caption="Package lines">
                      <THead>
                        <TR>
                          <TH>Line</TH>
                          <TH>Requirement</TH>
                          <TH numeric>Quantity</TH>
                          <TH>Required scope</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {data.lines.length === 0 ? (
                          <EmptyRow cols={4}>No lines in this package.</EmptyRow>
                        ) : (
                          data.lines.map((l) => (
                            <TR key={l.id}>
                              <RowHeader><Mono>{l.line_key}</Mono></RowHeader>
                              <TD>{l.requirement_code ?? <Mono>{l.requirement_revision_id.slice(0, 8)}</Mono>}</TD>
                              <TD numeric><Qty value={l.quantity} uom={l.uom} /></TD>
                              <TD className="max-w-[320px] text-xs text-muted-foreground">{(l.scope_json.required ?? []).join(', ') || 'Commercial scope per offer'}</TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                  <Section title="Evaluation policy">
                    <div className="p-4">
                      <KV
                        cols={2}
                        items={[
                          { label: 'Installed cost', value: String((data.evaluation_policy_json.weights as Record<string, string> | undefined)?.INSTALLED_COST ?? '—') },
                          { label: 'TCO', value: String((data.evaluation_policy_json.weights as Record<string, string> | undefined)?.TCO ?? '—') },
                          { label: 'Delivery', value: String((data.evaluation_policy_json.weights as Record<string, string> | undefined)?.DELIVERY ?? '—') },
                          { label: 'Technical', value: String((data.evaluation_policy_json.weights as Record<string, string> | undefined)?.TECHNICAL ?? '—') },
                          { label: 'Horizon', value: `${data.evaluation_policy_json.horizon_years ?? 5} years` },
                          { label: 'Discount rate', value: String(data.evaluation_policy_json.discount_rate ?? '0.08') },
                        ]}
                      />
                    </div>
                  </Section>
                </div>
              </TabsContent>

              <TabsContent value="offers">
                <Section
                  title="Latest offers per supplier"
                  description="A newer offer supersedes the previous revision; both remain auditable."
                  actions={
                    s.can('evaluation.calculate') && data.state !== 'DRAFT' ? (
                      <Button size="sm" onClick={() => setCalcOpen(true)}>
                        <Calculator aria-hidden /> Calculate evaluation
                      </Button>
                    ) : null
                  }
                >
                  <Table caption="Offers">
                    <THead>
                      <TR>
                        <TH>Supplier</TH>
                        <TH>Revision</TH>
                        <TH>State</TH>
                        <TH>Currency</TH>
                        <TH>Incoterms</TH>
                        <TH>Valid until</TH>
                        <TH>Received</TH>
                        <TH className="text-right">Detail</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.offers.length === 0 ? (
                        <EmptyRow cols={8}>No offers received.</EmptyRow>
                      ) : (
                        data.offers.map((o) => (
                          <TR key={o.id}>
                            <RowHeader>{o.supplier_name ?? o.supplier_key ?? 'Supplier'}</RowHeader>
                            <TD>Rev {o.revision_no}</TD>
                            <TD><StateBadge state={o.state} /></TD>
                            <TD>{o.currency}</TD>
                            <TD>{o.incoterms ?? '—'}</TD>
                            <TD><DateText value={o.valid_until} /></TD>
                            <TD><DateTimeText value={o.created_at} /></TD>
                            <TD className="text-right">
                              <Button size="sm" onClick={() => setOfferId(o.id)}>
                                View
                              </Button>
                            </TD>
                          </TR>
                        ))
                      )}
                    </TBody>
                  </Table>
                </Section>
              </TabsContent>

              <TabsContent value="evaluation">
                <div className="space-y-4">
                  <Section
                    title="Evaluations"
                    description="Calculated from offer revisions and approved normalization evidence."
                    actions={
                      s.can('evaluation.calculate') && data.state !== 'DRAFT' ? (
                        <Button size="sm" variant="primary" onClick={() => setCalcOpen(true)}>
                          <Calculator aria-hidden /> Calculate
                        </Button>
                      ) : null
                    }
                  >
                    <Table caption="Evaluations">
                      <THead>
                        <TR>
                          <TH>Revision</TH>
                          <TH>State</TH>
                          <TH>Fingerprint</TH>
                          <TH>Calculated</TH>
                          <TH>Staleness</TH>
                          <TH className="text-right">Open</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {data.evaluations.length === 0 ? (
                          <EmptyRow cols={6}>No evaluation calculated.</EmptyRow>
                        ) : (
                          data.evaluations.map((e) => (
                            <TR key={e.id} selected={e.id === evalId}>
                              <RowHeader>Rev {e.revision_no}</RowHeader>
                              <TD><StateBadge state={e.state} /></TD>
                              <TD><Mono className="text-[11px]">{e.input_fingerprint}</Mono></TD>
                              <TD><DateTimeText value={e.created_at} /></TD>
                              <TD>{e.stale_reason ? <span className="text-xs text-warning">{e.stale_reason}</span> : 'Current'}</TD>
                              <TD className="text-right">
                                <Button size="sm" onClick={() => setEvalId(e.id)}>
                                  Open
                                </Button>
                              </TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>

                  {evalId ? (
                    <QueryView q={evalQ} rows={4}>
                      {(detail) => {
                        const ev = detail.evaluation
                        const lines = detail.results.lines ?? []
                        return (
                          <Section
                            title={`Evaluation revision ${ev.revision_no}`}
                            description={`State ${humanize(ev.state)} · ${lines.length} offer lines`}
                            actions={
                              <div className="flex flex-wrap gap-1.5">
                                {ev.state === 'CALCULATED' && s.can('evaluation.submit') ? (
                                  <Button size="sm" loading={submitEval.isPending} onClick={() => submitEval.mutate(ev.id)}>
                                    Submit
                                  </Button>
                                ) : null}
                                {(ev.state === 'CALCULATED' || ev.state === 'IN_REVIEW') && s.can('evaluation.approve') ? (
                                  <Button size="sm" variant="primary" loading={approveEval.isPending} onClick={() => approveEval.mutate({ id: ev.id, etag: ev.etag })}>
                                    <ShieldCheck aria-hidden /> Approve
                                  </Button>
                                ) : null}
                                {ev.state === 'APPROVED' && !detail.is_stale && s.can('award.create') ? (
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={() => {
                                      setSelectedOfferLine('')
                                      setAwardOpen(true)
                                    }}
                                  >
                                    <Award aria-hidden /> Create award
                                  </Button>
                                ) : null}
                              </div>
                            }
                          >
                            {detail.is_stale ? (
                              <div className="border-b p-3">
                                <Callout tone="warning" title="Evaluation is stale">
                                  {detail.stale_reason} Recalculate before approval or award.
                                </Callout>
                              </div>
                            ) : null}
                            <Table caption="Evaluation results">
                              <THead>
                                <TR>
                                  <TH>Rank</TH>
                                  <TH>Supplier</TH>
                                  <TH numeric>Installed cost</TH>
                                  <TH numeric>TCO</TH>
                                  <TH numeric>Lead time</TH>
                                  <TH>Eligibility</TH>
                                  <TH numeric>Weighted score</TH>
                                  <TH>Basis</TH>
                                </TR>
                              </THead>
                              <TBody>
                                {lines.length === 0 ? (
                                  <EmptyRow cols={8}>No offers to evaluate.</EmptyRow>
                                ) : (
                                  [...lines]
                                    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
                                    .map((l) => (
                                      <EvalRow key={l.offer_id ?? l.offer_line_id ?? `${l.supplier_id}-${l.offer_revision_no}`} l={l} currency={data.currency} />
                                    ))
                                )}
                              </TBody>
                            </Table>
                            {detail.scores.length ? (
                              <div className="border-t p-3">
                                <p className="mb-1 text-xs font-semibold text-muted-foreground">Recorded scores</p>
                                <Table caption="Evaluation scores">
                                  <THead>
                                    <TR>
                                      <TH>Criterion</TH>
                                      <TH numeric>Weight</TH>
                                      <TH numeric>Score</TH>
                                      <TH>Eligible</TH>
                                      <TH>Note</TH>
                                    </TR>
                                  </THead>
                                  <TBody>
                                    {detail.scores.map((sc) => (
                                      <TR key={sc.criterion_code + (sc.score ?? '')}>
                                        <RowHeader>{humanize(sc.criterion_code)}</RowHeader>
                                        <TD numeric>{sc.weight ?? '—'}</TD>
                                        <TD numeric>{sc.score ?? '—'}</TD>
                                        <TD>{sc.eligible ? 'Yes' : <span className="text-danger">No</span>}</TD>
                                        <TD className="max-w-[320px] text-xs text-muted-foreground">{sc.note ?? '—'}</TD>
                                      </TR>
                                    ))}
                                  </TBody>
                                </Table>
                              </div>
                            ) : null}
                          </Section>
                        )
                      }}
                    </QueryView>
                  ) : (
                    <EmptyState title="Select an evaluation" message="Open an evaluation to review ranks, eligibility and staleness." icon={<Calculator />} />
                  )}
                </div>
              </TabsContent>

              <TabsContent value="award">
                <div className="space-y-4">
                  <Section title="Awards" description="The award freezes the evaluation inputs it was approved against.">
                    <Table caption="Awards">
                      <THead>
                        <TR>
                          <TH>Decision</TH>
                          <TH>State</TH>
                          <TH>Fingerprint</TH>
                          <TH>Approved by</TH>
                          <TH>Approved at</TH>
                          <TH className="text-right">Open</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {data.awards.length === 0 ? (
                          <EmptyRow cols={6}>No award drafted.</EmptyRow>
                        ) : (
                          data.awards.map((a) => (
                            <TR key={a.id} selected={a.id === awardId}>
                              <RowHeader><Mono>{a.id.slice(0, 8)}</Mono></RowHeader>
                              <TD><StateBadge state={a.state} /></TD>
                              <TD><Mono className="text-[11px]">{a.input_fingerprint}</Mono></TD>
                              <TD>{a.approved_by ?? '—'}</TD>
                              <TD><DateTimeText value={a.approved_at} /></TD>
                              <TD className="text-right">
                                <Button size="sm" onClick={() => setAwardId(a.id)}>
                                  Open
                                </Button>
                              </TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>

                  {awardId ? (
                    <QueryView q={awardQ} rows={4}>
                      {(detail) => (
                        <Section
                          title={`Award ${detail.award.id.slice(0, 8)}`}
                          description={`Reconciliation: ${humanize(detail.reconciliation ?? 'unknown')}`}
                          actions={
                            <div className="flex flex-wrap gap-1.5">
                              {detail.award.state === 'DRAFT' && s.can('award.create') ? (
                                <Button size="sm" loading={submitAward.isPending} onClick={() => submitAward.mutate(detail.award.id)}>
                                  Submit
                                </Button>
                              ) : null}
                              {(detail.award.state === 'DRAFT' || detail.award.state === 'IN_REVIEW') && s.can('award.approve') ? (
                                <Button
                                  size="sm"
                                  variant="primary"
                                  loading={approveAward.isPending}
                                  onClick={() => approveAward.mutate({ id: detail.award.id, etag: detail.award.etag, fingerprint: detail.award.input_fingerprint })}
                                >
                                  <ShieldCheck aria-hidden /> Approve award
                                </Button>
                              ) : null}
                            </div>
                          }
                        >
                          <div className="border-b p-4">
                            <KV
                              cols={3}
                              items={[
                                { label: 'Rationale', value: detail.award.rationale ?? '—' },
                                { label: 'Fingerprint', value: <Mono>{detail.award.input_fingerprint}</Mono> },
                                { label: 'Approved by', value: detail.award.approved_by ?? '—' },
                              ]}
                            />
                          </div>
                          <Table caption="Award lines">
                            <THead>
                              <TR>
                                <TH>Line</TH>
                                <TH>Supplier</TH>
                                <TH>Option</TH>
                                <TH numeric>Quantity</TH>
                                <TH numeric>Unit price</TH>
                              </TR>
                            </THead>
                            <TBody>
                              {detail.lines.length === 0 ? (
                                <EmptyRow cols={5}>No award lines.</EmptyRow>
                              ) : (
                                detail.lines.map((l) => (
                                  <TR key={l.id}>
                                    <RowHeader>{l.line_key ?? <Mono>{l.package_line_id.slice(0, 8)}</Mono>}</RowHeader>
                                    <TD>{l.supplier_name ?? '—'}</TD>
                                    <TD>{l.option_code ?? '—'}</TD>
                                    <TD numeric>{l.selected_quantity}</TD>
                                    <TD numeric><Money value={l.unit_price} /></TD>
                                  </TR>
                                ))
                              )}
                            </TBody>
                          </Table>
                          {detail.purchase_orders?.length ? (
                            <div className="border-t p-4">
                              <p className="mb-2 text-xs font-semibold text-muted-foreground">Purchase orders</p>
                              <div className="flex flex-wrap gap-2">
                                {detail.purchase_orders.map((po) => (
                                  <Link key={po.id} to={`/delivery/purchase-orders/${po.id}`} className="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs hover:bg-muted">
                                    <span className="code">{po.canonical_number}</span>
                                    <StateBadge state={po.state} />
                                  </Link>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="border-t p-3">
                              <Callout tone="info">The purchase order is generated by the procurement workstream after approval.</Callout>
                            </div>
                          )}
                        </Section>
                      )}
                    </QueryView>
                  ) : null}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryView>

      <CommandDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title="Issue sourcing package"
        description="Issued packages accept offers. Everything in the package is frozen at its approved revision."
        confirmLabel="Issue"
        run={() => issue.mutateAsync()}
        invalidate={[['sourcing']]}
        success="Package issued"
      >
        <p className="text-[13px] text-muted-foreground">
          {pkg?.lines.length ?? 0} lines will be visible to invited suppliers. You can still recalculate evaluations as offers arrive.
        </p>
      </CommandDialog>

      <Dialog
        open={calcOpen}
        onOpenChange={setCalcOpen}
        title="Calculate evaluation"
        description="Weights should total 1.0. Eligibility and unknown scope are enforced before ranking."
        footer={
          <>
            <Button onClick={() => setCalcOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={calculate.isPending} onClick={() => calculate.mutate()}>
              Calculate
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Installed cost weight">
            <Input inputMode="decimal" value={weights.INSTALLED_COST} onChange={(e) => setWeights({ ...weights, INSTALLED_COST: e.target.value })} />
          </Field>
          <Field label="TCO weight">
            <Input inputMode="decimal" value={weights.TCO} onChange={(e) => setWeights({ ...weights, TCO: e.target.value })} />
          </Field>
          <Field label="Delivery weight">
            <Input inputMode="decimal" value={weights.DELIVERY} onChange={(e) => setWeights({ ...weights, DELIVERY: e.target.value })} />
          </Field>
          <Field label="Technical weight">
            <Input inputMode="decimal" value={weights.TECHNICAL} onChange={(e) => setWeights({ ...weights, TECHNICAL: e.target.value })} />
          </Field>
          <Field label="Horizon (years)">
            <Input inputMode="numeric" value={weights.horizon_years} onChange={(e) => setWeights({ ...weights, horizon_years: e.target.value })} />
          </Field>
          <Field label="Discount rate">
            <Input inputMode="decimal" value={weights.discount_rate} onChange={(e) => setWeights({ ...weights, discount_rate: e.target.value })} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={offerOpen}
        onOpenChange={setOfferOpen}
        title="Submit offer"
        description="Price every package line. A new submission for the same supplier creates a new revision."
        size="xl"
        footer={
          <>
            <Button onClick={() => setOfferOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={submitOffer.isPending} disabled={!offerMeta.source_offer_key.trim() || (pkg?.lines ?? []).some((l) => !drafts[l.id]?.option_code || !drafts[l.id]?.unit_price)} onClick={() => submitOffer.mutate()}>
              Submit offer
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!s.isSupplier ? (
              <Field label="Supplier" required>
                <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Select supplier</option>
                  {(suppliers.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>{x.key} · {x.name}</option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Source offer key" required>
              <Input value={offerMeta.source_offer_key} onChange={(e) => setOfferMeta({ ...offerMeta, source_offer_key: e.target.value })} placeholder="SUP-OFR-2026-014" />
            </Field>
            <Field label="Currency">
              <Input value={offerMeta.currency} onChange={(e) => setOfferMeta({ ...offerMeta, currency: e.target.value.toUpperCase() })} maxLength={3} />
            </Field>
            <Field label="Incoterms">
              <Input value={offerMeta.incoterms} onChange={(e) => setOfferMeta({ ...offerMeta, incoterms: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Valid until">
              <Input type="date" value={offerMeta.valid_until} onChange={(e) => setOfferMeta({ ...offerMeta, valid_until: e.target.value })} />
            </Field>
          </div>
          <div className="space-y-2">
            {(pkg?.lines ?? []).map((l) => {
              const d = drafts[l.id] ?? { option_code: '', quantity: l.quantity, unit_price: '', lead_time_days: '', promised_delivery_date: '', annual_om_estimate: '', warranty_months: '' }
              const set = (patch: Partial<OfferLineDraft>) => setDrafts({ ...drafts, [l.id]: { ...d, ...patch } })
              return (
                <div key={l.id} className="rounded-md border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold"><span className="code">{l.line_key}</span> · {l.requirement_code ?? 'Requirement'} · <Qty value={l.quantity} uom={l.uom} /></p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
                    <Field label="Option" required className="lg:col-span-2">
                      <Select value={d.option_code} onChange={(e) => set({ option_code: e.target.value })}>
                        <option value="">Select option</option>
                        {(options.data ?? []).map((o) => (
                          <option key={o.id} value={o.option_code}>{o.option_code} · {o.name}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Quantity" required>
                      <Input inputMode="decimal" value={d.quantity} onChange={(e) => set({ quantity: e.target.value })} />
                    </Field>
                    <Field label="Unit price" required>
                      <Input inputMode="decimal" value={d.unit_price} onChange={(e) => set({ unit_price: e.target.value })} />
                    </Field>
                    <Field label="Lead time (days)">
                      <Input inputMode="numeric" value={d.lead_time_days} onChange={(e) => set({ lead_time_days: e.target.value })} />
                    </Field>
                    <Field label="Promised delivery">
                      <Input type="date" value={d.promised_delivery_date} onChange={(e) => set({ promised_delivery_date: e.target.value })} />
                    </Field>
                    <Field label="O&M / year">
                      <Input inputMode="decimal" value={d.annual_om_estimate} onChange={(e) => set({ annual_om_estimate: e.target.value })} />
                    </Field>
                    <Field label="Warranty (months)">
                      <Input inputMode="numeric" value={d.warranty_months} onChange={(e) => set({ warranty_months: e.target.value })} />
                    </Field>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!offerId}
        onOpenChange={(o) => !o && setOfferId('')}
        title={offerQ.data ? `Offer · ${offerQ.data.offer.supplier_name ?? offerQ.data.offer.supplier_key ?? 'Supplier'} · rev ${offerQ.data.offer.revision_no}` : 'Offer'}
        description="Normalization adjustments are proposed here and approved before they count."
        size="xl"
      >
        <QueryView q={offerQ} rows={4}>
          {(detail) => (
            <div className="space-y-4">
              <KV
                cols={4}
                items={[
                  { label: 'State', value: <StateBadge state={detail.offer.state} /> },
                  { label: 'Currency', value: detail.offer.currency },
                  { label: 'Incoterms', value: detail.offer.incoterms ?? '—' },
                  { label: 'Valid until', value: <DateText value={detail.offer.valid_until} /> },
                ]}
              />
              <Table caption="Offer lines">
                <THead>
                  <TR>
                    <TH>Line</TH>
                    <TH>Option</TH>
                    <TH numeric>Quantity</TH>
                    <TH numeric>Unit price</TH>
                    <TH numeric>Base amount</TH>
                    <TH>Lead time</TH>
                    <TH>Adjustments</TH>
                  </TR>
                </THead>
                <TBody>
                  {detail.lines.map((l) => (
                    <OfferLineRows key={l.id} line={l} onSelect={setSelectedOfferLine} selected={l.id === selectedOfferLine} onDecide={(id, approve) => decideAdjustment.mutate({ id, approve })} canDecide={s.can('adjustment.approve')} />
                  ))}
                </TBody>
              </Table>
              {s.can('adjustment.propose') ? (
                <div className="rounded-md border p-3">
                  <p className="mb-2 text-xs font-semibold">Propose normalization adjustment</p>
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Field label="Offer line" required>
                      <Select value={selectedOfferLine} onChange={(e) => setSelectedOfferLine(e.target.value)}>
                        <option value="">Select line</option>
                        {detail.lines.map((l) => (
                          <option key={l.id} value={l.id}>{l.line_key ?? l.id.slice(0, 8)} · {l.option_code ?? ''}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Category" required>
                      <Select value={adjustment.category} onChange={(e) => setAdjustment({ ...adjustment, category: e.target.value })}>
                        {['INSTALL', 'FREIGHT', 'SPARE_PARTS', 'COMMISSIONING', 'TRAINING', 'OTHER'].map((c) => (
                          <option key={c} value={c}>{humanize(c)}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount" required>
                      <Input inputMode="decimal" value={adjustment.amount} onChange={(e) => setAdjustment({ ...adjustment, amount: e.target.value })} />
                    </Field>
                    <Field label="Rationale" required>
                      <Input value={adjustment.rationale} onChange={(e) => setAdjustment({ ...adjustment, rationale: e.target.value })} />
                    </Field>
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" loading={addAdjustment.isPending} disabled={!selectedOfferLine || !adjustment.amount || !adjustment.rationale.trim()} onClick={() => addAdjustment.mutate()}>
                      <Plus aria-hidden /> Propose
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </QueryView>
      </Dialog>

      <Dialog
        open={awardOpen}
        onOpenChange={setAwardOpen}
        title="Create award"
        description="Choose the recommended offer. Every package line is awarded from that offer's evaluated lines."
        footer={
          <>
            <Button onClick={() => setAwardOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={createAward.isPending} disabled={!selectedOfferLine || !awardRationale.trim()} onClick={() => createAward.mutate()}>
              Draft award
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Recommended offer" required>
            <Select value={selectedOfferLine} onChange={(e) => setSelectedOfferLine(e.target.value)}>
              <option value="">Select offer</option>
              {(evalQ.data?.results.lines ?? [])
                .filter((x) => x.eligible)
                .map((x) => (
                  <option key={x.offer_id} value={x.offer_id}>{x.supplier_name ?? x.supplier_key} · rank {x.rank ?? '—'}</option>
                ))}
            </Select>
          </Field>
          <Field label="Award rationale" required hint="Recorded in the audit trail and visible on the purchase order.">
            <Textarea value={awardRationale} onChange={(e) => setAwardRationale(e.target.value)} placeholder="Best weighted score and earliest compliant delivery; technical deviations accepted by engineering." />
          </Field>
        </div>
      </Dialog>
    </>
  )
}

function EvalRow({ l, currency }: { l: EvaluationResultLine; currency: string }) {
  return (
    <TR>
      <RowHeader>{l.rank ?? '—'}</RowHeader>
      <TD>{l.supplier_name ?? l.supplier_key ?? '—'}</TD>
      <TD numeric><Money value={l.normalized_installed_cost} currency={currency} /></TD>
      <TD numeric><Money value={l.tco_pv} currency={currency} /></TD>
      <TD numeric>{l.lead_time_days ?? '—'}</TD>
      <TD>
        {l.eligible ? (
          <span className="text-xs text-success">Eligible</span>
        ) : (
          <span className="text-xs text-danger" title={(l.ineligible_reasons ?? []).join('; ')}>Ineligible</span>
        )}
        {(l.unknowns ?? []).length ? <span className="mt-0.5 block text-[11px] text-warning" title={(l.unknowns ?? []).join('; ')}>{l.unknowns?.length} unknown</span> : null}
      </TD>
      <TD numeric>{l.weighted_score ?? '—'}</TD>
      <TD>{l.basis_complete === false ? <span className="text-xs text-warning">Incomplete</span> : <span className="text-xs text-muted-foreground">Complete</span>}</TD>
    </TR>
  )
}

function OfferLineRows({
  line,
  selected,
  onSelect,
  onDecide,
  canDecide,
}: {
  line: OfferLine
  selected: boolean
  onSelect: (id: string) => void
  onDecide: (id: string, approve: boolean) => void
  canDecide: boolean
}) {
  return (
    <>
      <TR selected={selected} className={cn('cursor-pointer')} onClick={() => onSelect(line.id)}>
        <RowHeader>{line.line_key ?? <Mono>{line.id.slice(0, 8)}</Mono>}</RowHeader>
        <TD>{line.option_code ?? '—'}</TD>
        <TD numeric><Qty value={line.quantity} /></TD>
        <TD numeric><Money value={line.unit_price} /></TD>
        <TD numeric><Money value={line.base_amount} /></TD>
        <TD>{line.lead_time_days ? `${line.lead_time_days} days` : '—'}</TD>
        <TD>
          {line.adjustments?.length ? (
            <div className="space-y-1">
              {line.adjustments.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span>{humanize(a.category)}</span>
                  <span className="tabular-nums">{a.amount ?? 'Unknown'}</span>
                  <StateBadge state={a.state} />
                  {a.state === 'PROPOSED' && canDecide ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => onDecide(a.id, true)}>Approve</Button>
                      <Button size="sm" variant="ghost" onClick={() => onDecide(a.id, false)}>Reject</Button>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </TD>
      </TR>
      {(line.deviations ?? []).length ? (
        <TR>
          <TD colSpan={7} className="bg-muted/30">
            <ul className="space-y-0.5 text-[11px]">
              {line.deviations?.map((d) => (
                <li key={d.id}>
                  <span className="font-medium">{d.criterion_ref}</span> · {d.mandatory ? 'mandatory' : 'advisory'} · {humanize(d.severity)} · {humanize(d.disposition)} — {d.description}
                </li>
              ))}
            </ul>
          </TD>
        </TR>
      ) : null}
    </>
  )
}
