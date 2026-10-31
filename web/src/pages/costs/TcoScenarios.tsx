import { Calculator, Info, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { costs } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { TcoScenario } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { Badge } from '@/components/ui/badge'
import { Callout, EmptyState, Money, PageHeader, QueryView, Section } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'
import { formatPercent } from '@/lib/format'

interface LineDraft {
  year: string
  category: string
  amount: string
  kind: string
}

const blankLine = (year: number): LineDraft => ({ year: String(year), category: 'OPEX', amount: '', kind: 'FORECAST' })

export function TcoScenarios() {
  const s = useSession()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const q = useApi(['costs', 'tco'], costs.tcoScenarios)
  const scenarios = asList<TcoScenario>(q.data)
  const current = scenarios.find((x) => x.id === selected) ?? scenarios[0] ?? null

  const [name, setName] = useState('')
  const [subjectType, setSubjectType] = useState('OPTION')
  const [subjectId, setSubjectId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [horizon, setHorizon] = useState('10')
  const [rate, setRate] = useState('0.08')
  const [timing, setTiming] = useState('END_OF_YEAR')
  const [illustrative, setIllustrative] = useState(true)
  const [lines, setLines] = useState<LineDraft[]>([blankLine(0), { year: '1', category: 'CAPEX', amount: '', kind: 'FORECAST' }, blankLine(2)])

  const sortedLines = useMemo(() => [...lines].sort((a, b) => Number(a.year) - Number(b.year)), [lines])
  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  const create = useCommand({
    run: () =>
      costs.createTco({
        name: name.trim(),
        subject_type: subjectType,
        subject_id: subjectId.trim() || null,
        currency: currency.toUpperCase().slice(0, 3),
        horizon_years: Number(horizon) || 1,
        discount_rate: rate.trim(),
        timing,
        is_illustrative: illustrative,
        lines: sortedLines
          .filter((l) => l.amount.trim())
          .map((l) => ({ year: Number(l.year) || 0, category: l.category.trim().toUpperCase(), amount: l.amount.trim(), kind: l.kind })),
      }),
    invalidate: [['costs', 'tco']],
    success: (sc) => `Scenario "${sc.name}" created`,
    onSuccess: (sc) => {
      setOpen(false)
      setSelected(sc.id)
      setName('')
      setLines([blankLine(0), { year: '1', category: 'CAPEX', amount: '', kind: 'FORECAST' }, blankLine(2)])
    },
  })

  const valid = !!name.trim() && !!rate.trim() && !!horizon && lines.some((l) => l.amount.trim())

  return (
    <>
      <PageHeader
        eyebrow="Cost intelligence"
        title="TCO scenarios"
        description="Total cost of ownership over a horizon, with explicit discount timing. Assumptions and forecasts stay labelled; only actuals are evidence."
        actions={
          s.can('tco.create') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus aria-hidden /> New scenario
            </Button>
          ) : null
        }
      />

      <Callout className="mb-4" tone="info" icon={<Info />} title="Present value is a decision aid, not a commitment">
        Each scenario shows its undiscounted total and present value. The discount rate, timing and illustrative flag are stored with the scenario.
      </Callout>

      <div className="grid gap-4 lg:grid-cols-5">
        <Section className="lg:col-span-2" title={`${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`}>
          <QueryView q={q} rows={5} empty={<EmptyState icon={<Calculator />} title="No TCO scenarios" message="Compare options or equipment classes over a multi-year horizon." />}>
            {() => (
              <Table caption="TCO scenarios">
                <THead>
                  <TR>
                    <TH>Scenario</TH>
                    <TH>Subject</TH>
                    <TH numeric>PV</TH>
                  </TR>
                </THead>
                <TBody>
                  {scenarios.length === 0 ? (
                    <EmptyRow cols={3}>No scenarios.</EmptyRow>
                  ) : (
                    scenarios.map((sc) => (
                      <TR key={sc.id} selected={current?.id === sc.id}>
                        <RowHeader>
                          <button type="button" className="text-left font-medium text-accent underline-offset-2 hover:underline" onClick={() => setSelected(sc.id)}>
                            {sc.name}
                          </button>
                          <span className="block text-[11px] text-muted-foreground">{sc.horizon_years} years · {formatPercent(sc.discount_rate, 1) ?? '—'}</span>
                        </RowHeader>
                        <TD>{humanize(sc.subject_type)}</TD>
                        <TD numeric>
                          <Money value={sc.present_value} currency={sc.currency} />
                          {sc.is_illustrative ? <span className="block"><Badge tone="neutral">Illustrative</Badge></span> : null}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            )}
          </QueryView>
        </Section>

        <Section className="lg:col-span-3" title={current ? current.name : 'Select a scenario'} description={current ? `${humanize(current.subject_type)} · ${current.horizon_years} years · ${humanize(current.timing)} discounting` : undefined}>
          {!current ? (
            <EmptyState icon={<Calculator />} title="Nothing selected" message="Choose a scenario to see its lines and totals." />
          ) : (
            <div className="space-y-3 p-4">
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Undiscounted</p>
                  <p className="mt-0.5 text-lg font-semibold"><Money value={current.undiscounted_total} currency={current.currency} /></p>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Present value</p>
                  <p className="mt-0.5 text-lg font-semibold"><Money value={current.present_value} currency={current.currency} /></p>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Discount rate</p>
                  <p className="mt-0.5 text-lg font-semibold">{formatPercent(current.discount_rate, 1) ?? '—'}</p>
                </div>
              </div>
              {current.subject_id ? <p className="text-xs text-muted-foreground">Subject id <span className="code">{current.subject_id}</span></p> : null}
              {current.is_illustrative ? (
                <Callout tone="neutral" title="Illustrative scenario">Includes forecast or assumption lines; not recognized actuals.</Callout>
              ) : null}
              <Table caption="TCO lines">
                <THead>
                  <TR>
                    <TH numeric>Year</TH>
                    <TH>Category</TH>
                    <TH>Kind</TH>
                    <TH numeric>Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {current.lines.length === 0 ? (
                    <EmptyRow cols={4}>No lines.</EmptyRow>
                  ) : (
                    current.lines.map((l, i) => (
                      <TR key={`${l.year}-${l.category}-${i}`}>
                        <RowHeader className="num">{l.year}</RowHeader>
                        <TD>{humanize(l.category)}</TD>
                        <TD><Badge tone={l.kind === 'ACTUAL' ? 'success' : l.kind === 'FORECAST' ? 'info' : 'neutral'}>{humanize(l.kind)}</Badge></TD>
                        <TD numeric><Money value={l.amount} currency={current.currency} /></TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </div>
          )}
        </Section>
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New TCO scenario"
        description="Lines are grouped by year. The server computes undiscounted total and present value with the chosen timing."
        size="xl"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>Create scenario</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Option A — new generator" />
            </Field>
            <Field label="Subject type" required>
              <Select value={subjectType} onChange={(e) => setSubjectType(e.target.value)}>
                <option value="OPTION">Option</option>
                <option value="EQUIPMENT_CLASS">Equipment class</option>
                <option value="PACKAGE">Sourcing package</option>
                <option value="UNIT">Asset</option>
              </Select>
            </Field>
            <Field label="Subject id" hint="Optional internal id to link the scenario.">
              <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} />
            </Field>
            <Field label="Currency" required>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
            </Field>
            <Field label="Horizon (years)" required>
              <Input type="number" min={1} value={horizon} onChange={(e) => setHorizon(e.target.value)} />
            </Field>
            <Field label="Discount rate" required hint="Decimal between 0 and 1, e.g. 0.08.">
              <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </Field>
            <Field label="Discount timing">
              <Select value={timing} onChange={(e) => setTiming(e.target.value)}>
                <option value="END_OF_YEAR">End of year</option>
                <option value="BEGIN_OF_YEAR">Beginning of year</option>
              </Select>
            </Field>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium">Cost lines</p>
              <Button size="sm" onClick={() => setLines((xs) => [...xs, blankLine(xs.length + 1)])}><Plus aria-hidden /> Add line</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 items-end gap-2">
                  <Field label={i === 0 ? 'Year' : ''} className="col-span-2"><Input type="number" min={0} value={l.year} onChange={(e) => setLine(i, { year: e.target.value })} /></Field>
                  <Field label={i === 0 ? 'Category' : ''} className="col-span-4"><Input value={l.category} onChange={(e) => setLine(i, { category: e.target.value.toUpperCase() })} /></Field>
                  <Field label={i === 0 ? 'Amount' : ''} className="col-span-3"><Input inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></Field>
                  <Field label={i === 0 ? 'Kind' : ''} className="col-span-2">
                    <Select value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value })}>
                      <option value="FORECAST">Forecast</option>
                      <option value="ACTUAL">Actual</option>
                      <option value="ASSUMPTION">Assumption</option>
                    </Select>
                  </Field>
                  <div className="col-span-1 pb-0.5">
                    <Button size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))} disabled={lines.length <= 1}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Checkbox checked={illustrative} onChange={(e) => setIllustrative(e.target.checked)} label="Mark as illustrative (contains forecasts or assumptions)" />
        </div>
      </Dialog>
    </>
  )
}
