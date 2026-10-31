import { BarChart3 } from 'lucide-react'
import { useState } from 'react'
import { planning, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { BenchmarkObservation, BenchmarkRunResponse, RequirementListRow, RequirementRevision } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Select } from '@/components/ui/form'
import { Callout, DateText, EmptyState, Money, PageHeader, Qty, QueryView, Section } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

export function Benchmarks() {
  const s = useSession()
  const [cls, setCls] = useState('')
  const [open, setOpen] = useState(false)
  const [requirementId, setRequirementId] = useState('')
  const [revisionId, setRevisionId] = useState('')
  const [result, setResult] = useState<BenchmarkRunResponse | null>(null)

  const classes = useApi(['ref', 'equipment-classes'], reference.equipmentClasses(), { staleTime: 10 * 60_000 })
  const observations = useApi(['planning', 'benchmark-observations', cls || 'all'], planning.benchmarkObservations(cls || undefined))
  const requirements = useApi(['planning', 'requirements', 'all'], planning.requirements(null), { enabled: open })
  const detail = useApi(['planning', 'requirement', requirementId], planning.requirement(requirementId), { enabled: !!requirementId })

  const run = useCommand({
    run: (id: string) => planning.runBenchmark({ requirement_revision_id: id }),
    invalidate: [['planning']],
    success: (r) => `Benchmark ${humanize(r.run.state)} · ${r.run.sample_count} samples`,
    onSuccess: (r) => {
      setResult(r)
      setOpen(false)
    },
  })

  const revisions: RequirementRevision[] = detail.data?.revisions ?? []

  return (
    <>
      <PageHeader
        eyebrow="Planning & BOQ"
        title="Benchmarks"
        description="Comparable cost and reliability observations, normalized to the same duty and capacity."
        actions={
          s.can('benchmark.run') ? (
            <Button
              variant="primary"
              onClick={() => {
                setResult(null)
                setOpen(true)
              }}
            >
              <BarChart3 aria-hidden /> Run benchmark
            </Button>
          ) : null
        }
      />

      {result ? (
        <Section
          className="mb-4"
          title={`Benchmark ${humanize(result.run.state)}`}
          description={`Revision ${result.run.requirement_revision_id.slice(0, 8)} · ${result.run.sample_count} observations · cutoff ${new Date(result.run.evidence_cutoff).toLocaleString()}`}
        >
          <div className="space-y-3 p-4">
            {result.run.state === 'INSUFFICIENT_EVIDENCE' ? (
              <Callout tone="warning" title="Insufficient evidence">
                Fewer than the required comparable observations exist. The product reports the gap instead of estimating a value.
              </Callout>
            ) : null}
            <Table caption="Benchmark result metrics">
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
                {result.results.length === 0 ? (
                  <EmptyRow cols={7}>No metric could be calculated from the comparable cohort.</EmptyRow>
                ) : (
                  result.results.map((m) => (
                    <TR key={m.id}>
                      <RowHeader>{humanize(m.metric_code)}</RowHeader>
                      <TD>{humanize(m.basis)}</TD>
                      <TD numeric><Money value={m.value_min} currency={m.unit} /></TD>
                      <TD numeric><Money value={m.value_median} currency={m.unit} /></TD>
                      <TD numeric><Money value={m.value_max} currency={m.unit} /></TD>
                      <TD numeric>{m.sample_count}</TD>
                      <TD className="max-w-[260px] text-xs text-muted-foreground">{m.coverage_note ?? '—'}</TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
            {result.excluded.length ? (
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Excluded observations ({result.excluded.length})</p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {result.excluded.map((x, i) => (
                    <li key={i}>
                      {x.source_project_code ?? x.observation_id ?? 'Observation'} — {x.reason ?? (x.reasons ?? []).join('; ') ?? 'Excluded'}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section
        title={`${asList(observations.data).length} observation${asList(observations.data).length === 1 ? '' : 's'}`}
        description="Evidence from completed projects. Cutoff and scope are enforced by the benchmark run."
        actions={
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            Equipment class
            <Select value={cls} onChange={(e) => setCls(e.target.value)} className="w-52">
              <option value="">All classes</option>
              {(classes.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>{k.code} · {k.name}</option>
              ))}
            </Select>
          </label>
        }
      >
        <QueryView
          q={observations}
          rows={6}
          empty={<EmptyState icon={<BarChart3 />} title="No observations" message="Completed project evidence will appear here as it is imported." />}
        >
          {() => (
            <Table caption="Benchmark observations">
              <THead>
                <TR>
                  <TH>Source</TH>
                  <TH>Duty / capacity</TH>
                  <TH numeric>Purchase cost</TH>
                  <TH numeric>Installed cost</TH>
                  <TH numeric>Failures</TH>
                  <TH>Observed</TH>
                  <TH>Scope</TH>
                </TR>
              </THead>
              <TBody>
                {asList<BenchmarkObservation>(observations.data).map((o) => (
                  <TR key={o.id}>
                    <RowHeader>
                      <span className="code">{o.source_project_code}</span>
                      <span className="mt-0.5 block max-w-[260px] truncate text-[11px] text-muted-foreground" title={o.source_ref}>{o.source_ref}</span>
                    </RowHeader>
                    <TD>
                      {o.duty || o.capacity ? (
                        <span className="inline-flex flex-wrap items-center gap-x-2">
                          {o.duty ? <span>{o.duty}</span> : null}
                          {o.capacity ? <Qty value={o.capacity} uom={o.capacity_unit} /> : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD numeric><Money value={o.purchase_cost} currency={o.currency} /></TD>
                    <TD numeric><Money value={o.installed_cost} currency={o.currency} /></TD>
                    <TD numeric>{o.commissioning_failures}</TD>
                    <TD><DateText value={o.observed_at} /></TD>
                    <TD className="max-w-[220px] text-xs text-muted-foreground">{o.scope_included.join(', ') || '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Run benchmark"
        description="Calculates normalized cost statistics from observations of the same class, duty and capacity."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={run.isPending} disabled={!revisionId} onClick={() => run.mutate(revisionId)}>
              Calculate
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Requirement" required>
            <Select
              value={requirementId}
              onChange={(e) => {
                setRequirementId(e.target.value)
                setRevisionId('')
              }}
            >
              <option value="">Select requirement</option>
              {asList<RequirementListRow>(requirements.data).map((r) => (
                <option key={r.id} value={r.id}>{r.code} · {r.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="Revision" required hint="Use the approved revision for a sourcing-grade benchmark.">
            <Select value={revisionId} onChange={(e) => setRevisionId(e.target.value)} disabled={!requirementId || detail.isPending}>
              <option value="">Select revision</option>
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>Rev {r.revision_no} · {humanize(r.state)}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  )
}
