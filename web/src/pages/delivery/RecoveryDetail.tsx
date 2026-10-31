import { ArrowLeft, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { assets, quality } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { PhysicalUnit } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { CommandDialog } from '@/components/CommandDialog'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Callout,
  DateText,
  DateTimeText,
  ErrorPanel,
  IdentityBand,
  KV,
  LoadingBlock,
  Money,
  Mono,
  PageHeader,
  Section,
  StateBadge,
} from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'
import { localInputToISO, todayISO } from '@/lib/format'

type Action = 'disposition' | 'remove' | 'fit' | 'release' | 'close'

const ROUTES = ['REPAIR_AND_WAIT', 'REPLACE_FROM_SPARE', 'TAKE_FROM_DONOR'] as const
const TEST_TYPES = ['RETEST', 'FAT', 'SAT', 'COMMISSIONING'] as const

export function RecoveryDetail() {
  const { caseId = '' } = useParams()
  const s = useSession()
  const c = useAppContext()
  const [action, setAction] = useState<Action | null>(null)

  const q = useApi(['quality', 'case', caseId], quality.recoveryCase(caseId), { enabled: !!caseId })
  const units = useApi(['delivery', 'units', 'recovery-candidates'], assets.units({ programme_id: c.programmeId ?? null, include_components: true }), { enabled: !!action })
  const unitList = useMemo(() => asList<PhysicalUnit>(units.data), [units.data])

  // disposition
  const [route, setRoute] = useState<string>('REPAIR_AND_WAIT')
  const [replacementId, setReplacementId] = useState('')
  const [donorId, setDonorId] = useState('')
  const [responsible, setResponsible] = useState('')
  const [completion, setCompletion] = useState('')
  const [replacementEta, setReplacementEta] = useState('')
  // remove / fit
  const [returnRef, setReturnRef] = useState('')
  const [fittedAt, setFittedAt] = useState('')
  // release
  const [retestId, setRetestId] = useState('')
  // close
  const [cost, setCost] = useState('')
  const [currency, setCurrency] = useState('USD')
  // retest dialog
  const [retestOpen, setRetestOpen] = useState(false)
  const [testType, setTestType] = useState<string>('RETEST')
  const [testRef, setTestRef] = useState('')
  const [testResult, setTestResult] = useState('PASS')
  const [testAt, setTestAt] = useState('')

  const d = q.data
  const passingRetests = (d?.tests ?? []).filter((t) => t.result === 'PASS' && (TEST_TYPES as readonly string[]).includes(t.test_type))

  const recordRetest = useCommand({
    run: () =>
      quality.recordTest({
        unit_id: d?.parent_unit_id,
        test_type: testType,
        test_ref: testRef.trim(),
        result: testResult,
        stage: 'RETEST',
        performed_at: localInputToISO(testAt) ?? undefined,
        component_unit_id: d?.failed_component_id ?? undefined,
      }),
    invalidate: [['quality']],
    success: 'Test recorded',
    onSuccess: () => {
      setRetestOpen(false)
      setTestRef('')
      setTestAt('')
    },
  })

  if (q.isPending) {
    return (
      <>
        <PageHeader eyebrow="Delivery" title="Recovery case" />
        <LoadingBlock rows={8} label="Loading case" />
      </>
    )
  }
  if (q.isError) {
    return (
      <>
        <PageHeader eyebrow="Delivery" title="Recovery case" />
        <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
      </>
    )
  }
  if (!d) return null

  const body = (): Record<string, unknown> => {
    if (action === 'disposition') {
      return {
        route,
        replacement_unit_id: route === 'REPLACE_FROM_SPARE' ? replacementId || null : null,
        donor_unit_id: route === 'TAKE_FROM_DONOR' ? donorId || null : null,
        responsible_party: responsible.trim() || null,
        expected_completion: completion || null,
        replacement_eta: replacementEta || null,
      }
    }
    if (action === 'remove') return { supplier_return_ref: returnRef.trim() || null }
    if (action === 'fit') return { replacement_unit_id: replacementId || null, fitted_at: localInputToISO(fittedAt) ?? undefined }
    if (action === 'release') return { retest_id: retestId }
    if (action === 'close') return { recovery_cost: cost.trim() || null, currency: currency || 'USD' }
    return {}
  }
  const canRun =
    action === 'disposition'
      ? !!route && (route !== 'REPLACE_FROM_SPARE' || !!replacementId) && (route !== 'TAKE_FROM_DONOR' || !!donorId)
      : action === 'release'
        ? !!retestId
        : true

  return (
    <>
      <PageHeader
        eyebrow={
          <Link className="inline-flex items-center gap-1 hover:underline" to="/delivery/recovery">
            <ArrowLeft className="size-3" aria-hidden /> FAT &amp; recovery
          </Link>
        }
        title={<span className="inline-flex items-center gap-2"><span className="code">{d.ncr_number}</span><StateBadge state={d.state} /></span>}
        description={d.description}
        meta={
          <>
            <span className="text-xs text-muted-foreground">Failure stage</span>
            <span className="text-xs font-medium">{humanize(d.failure_stage)}</span>
            <span className="text-xs text-muted-foreground">Opened</span>
            <DateTimeText value={d.created_at} />
          </>
        }
      />

      <IdentityBand
        items={[
          { label: 'Parent asset', value: <span className="code">{d.parent_asset_code ?? d.parent_unit_id.slice(0, 8)}</span> },
          { label: 'Failed component', value: d.failed_component_code ? <span className="code">{d.failed_component_code}</span> : <span className="text-ink-muted">Not recorded</span> },
          { label: 'Slot', value: d.slot_code ?? <span className="text-ink-muted">—</span> },
          { label: 'Route', value: d.route ? humanize(d.route) : <span className="text-ink-muted">Not dispositioned</span> },
          { label: 'Responsible', value: d.responsible_party ?? <span className="text-ink-muted">—</span> },
        ]}
        right={<StateBadge state={d.state} />}
      />

      {d.impacts_json?.length ? (
        <Callout className="mb-4" tone="warning" title="Project impacts" icon={<Wrench />}>
          <ul className="space-y-1">
            {d.impacts_json.map((im, i) => (
              <li key={`${im.project_id ?? i}-${i}`}>
                <span className="font-medium">{im.project_code ?? 'No project'}</span> · {im.impact}
                {im.eta ? <span className="text-muted-foreground"> · ETA <DateText value={im.eta} /></span> : null}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {d.state === 'OPEN' && s.can('recovery.manage') ? (
          <Button variant="primary" onClick={() => { setRoute('REPAIR_AND_WAIT'); setAction('disposition') }}>Record disposition</Button>
        ) : null}
        {['OPEN', 'DISPOSITIONED'].includes(d.state) && s.can('recovery.manage') ? (
          <Button onClick={() => setAction('remove')}>Remove failed component</Button>
        ) : null}
        {['DISPOSITIONED', 'COMPONENT_REMOVED'].includes(d.state) && s.can('recovery.manage') ? (
          <Button onClick={() => { setReplacementId(d.replacement_unit_id ?? ''); setFittedAt(''); setAction('fit') }}>Fit replacement</Button>
        ) : null}
        {['RETEST_REQUIRED', 'DISPOSITIONED'].includes(d.state) && s.can('test.record') ? (
          <Button onClick={() => { setTestAt(''); setTestRef(''); setRetestOpen(true) }}>Record test</Button>
        ) : null}
        {['RETEST_REQUIRED', 'DISPOSITIONED'].includes(d.state) && s.can('recovery.release') ? (
          <Button variant="primary" onClick={() => { setRetestId(passingRetests[0]?.id ?? ''); setAction('release') }}>Release case</Button>
        ) : null}
        {d.state === 'RELEASED' && s.can('recovery.manage') ? (
          <Button onClick={() => { setCost(d.recovery_cost ?? ''); setCurrency(d.currency ?? 'USD'); setAction('close') }}>Close case</Button>
        ) : null}
      </div>

      <Tabs defaultValue="overview" className="rounded-lg border bg-card px-4 pb-4 pt-2">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tests">Tests ({d.tests?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="components">Component links ({d.links?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="space-y-4">
            <KV
              cols={3}
              items={[
                { label: 'Recovery cost', value: <Money value={d.recovery_cost} currency={d.currency} /> },
                { label: 'Replacement ETA', value: <DateText value={d.replacement_eta} /> },
                { label: 'Expected completion', value: <DateText value={d.expected_completion} /> },
                { label: 'Dispositioned by', value: d.disposition_by ?? '—' },
                { label: 'Released by', value: d.released_by ?? '—' },
                { label: 'Released at', value: <DateTimeText value={d.released_at} /> },
                { label: 'Supplier return reference', value: d.supplier_return_ref ? <Mono>{d.supplier_return_ref}</Mono> : '—' },
                { label: 'Replacement unit', value: d.replacement_unit_id ? <Mono>{d.replacement_unit_id.slice(0, 8)}</Mono> : '—' },
                { label: 'Donor unit', value: d.donor_unit_id ? <Mono>{d.donor_unit_id.slice(0, 8)}</Mono> : '—' },
              ]}
            />
            <Section title="Lifecycle" description="Open → disposition → component removed → replacement fitted → retest → released → closed.">
              <ol className="space-y-2 px-4 py-3 text-[13px]">
                {['OPEN', 'DISPOSITIONED', 'COMPONENT_REMOVED', 'RETEST_REQUIRED', 'RELEASED', 'CLOSED'].map((step) => {
                  const done = ['OPEN', 'DISPOSITIONED', 'COMPONENT_REMOVED', 'RETEST_REQUIRED', 'RELEASED', 'CLOSED'].indexOf(d.state) >= ['OPEN', 'DISPOSITIONED', 'COMPONENT_REMOVED', 'RETEST_REQUIRED', 'RELEASED', 'CLOSED'].indexOf(step)
                  return (
                    <li key={step} className="flex items-center gap-2">
                      <span className={done ? 'size-2 rounded-full bg-success' : 'size-2 rounded-full bg-border'} aria-hidden />
                      <span className={done ? 'font-medium' : 'text-muted-foreground'}>{humanize(step)}</span>
                      {d.state === step ? <span className="text-xs text-accent">Current</span> : null}
                    </li>
                  )
                })}
              </ol>
            </Section>
          </div>
        </TabsContent>

        <TabsContent value="tests">
          <Section title="Test records" description="A passing RETEST, FAT, SAT or commissioning test released after the fitting is required.">
            <Table caption="Test records">
              <THead>
                <TR>
                  <TH>Test reference</TH>
                  <TH>Type</TH>
                  <TH>Stage</TH>
                  <TH>Result</TH>
                  <TH>Performed</TH>
                  <TH>Witnessed by</TH>
                  <TH>Evidence</TH>
                </TR>
              </THead>
              <TBody>
                {(d.tests ?? []).length === 0 ? (
                  <EmptyRow cols={7}>No tests recorded for this unit.</EmptyRow>
                ) : (
                  (d.tests ?? []).map((t) => (
                    <TR key={t.id}>
                      <RowHeader><Mono>{t.test_ref}</Mono></RowHeader>
                      <TD>{t.test_type}</TD>
                      <TD>{humanize(t.stage)}</TD>
                      <TD><StateBadge state={t.result} /></TD>
                      <TD><DateTimeText value={t.performed_at} /></TD>
                      <TD>{t.witnessed_by ?? '—'}</TD>
                      <TD><Mono>{t.evidence_ref}</Mono></TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </Section>
        </TabsContent>

        <TabsContent value="components">
          <Section title="Component links" description="Fitted component history for this case, including removal window.">
            <Table caption="Component links">
              <THead>
                <TR>
                  <TH>Child asset</TH>
                  <TH>Slot</TH>
                  <TH>Valid from</TH>
                  <TH>Valid to</TH>
                  <TH>Install reason</TH>
                  <TH>Removal reason</TH>
                </TR>
              </THead>
              <TBody>
                {(d.links ?? []).length === 0 ? (
                  <EmptyRow cols={6}>No component links recorded for this case.</EmptyRow>
                ) : (
                  (d.links ?? []).map((l) => (
                    <TR key={l.id}>
                      <RowHeader><Mono>{(l as { child_asset_code?: string }).child_asset_code ?? l.child_unit_id.slice(0, 8)}</Mono></RowHeader>
                      <TD>{l.slot_code}</TD>
                      <TD><DateTimeText value={l.valid_from} /></TD>
                      <TD><DateTimeText value={l.valid_to} /></TD>
                      <TD>{l.install_reason ?? '—'}</TD>
                      <TD>{l.removal_reason ?? '—'}</TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </Section>
        </TabsContent>
      </Tabs>

      <CommandDialog
        open={!!action}
        onOpenChange={(o) => {
          if (!o) setAction(null)
        }}
        title={
          action === 'disposition'
            ? 'Record disposition'
            : action === 'remove'
              ? 'Remove failed component'
              : action === 'fit'
                ? 'Fit replacement'
                : action === 'release'
                  ? 'Release recovery case'
                  : 'Close recovery case'
        }
        description={
          action === 'disposition'
            ? 'The route determines which impacts are recorded before any component moves.'
            : action === 'release'
              ? 'Engineering releases the parent only with a passing retest recorded after the fitting.'
              : action === 'close'
                ? 'Closing records the recovery cost against the parent asset.'
                : undefined
        }
        confirmLabel={action === 'disposition' ? 'Record disposition' : action === 'remove' ? 'Remove component' : action === 'fit' ? 'Fit replacement' : action === 'release' ? 'Release' : 'Close case'}
        run={() =>
          quality.command(
            caseId,
            action === 'remove' ? 'remove-component' : action === 'fit' ? 'fit-replacement' : action === 'release' ? 'release' : action === 'close' ? 'close' : 'disposition',
            body(),
          )
        }
        invalidate={[['quality'], ['delivery']]}
        success="Recovery case updated"
        onDone={() => {
          setAction(null)
          setRetestId('')
          setCost('')
        }}
        disabled={!canRun ? 'Complete the required fields first.' : undefined}
      >
        {action === 'disposition' ? (
          <div className="space-y-3">
            <Field label="Route" required>
              <Select value={route} onChange={(e) => setRoute(e.target.value)}>
                {ROUTES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
              </Select>
            </Field>
            {route === 'REPLACE_FROM_SPARE' ? (
              <Field label="Replacement unit" required hint="Must be an approved spare for this slot and not currently fitted.">
                <Select value={replacementId} onChange={(e) => setReplacementId(e.target.value)}>
                  <option value="">Select spare</option>
                  {unitList.filter((u) => u.is_spare).map((u) => (
                    <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'}</option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {route === 'TAKE_FROM_DONOR' ? (
              <Field label="Donor unit" required hint="The donor loses its fitted component in this slot.">
                <Select value={donorId} onChange={(e) => setDonorId(e.target.value)}>
                  <option value="">Select donor</option>
                  {unitList.filter((u) => u.id !== d.parent_unit_id).map((u) => (
                    <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'}</option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Responsible party">
                <Input value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder="Supplier or team" />
              </Field>
              <Field label="Expected completion">
                <Input type="date" value={completion} min={todayISO()} onChange={(e) => setCompletion(e.target.value)} />
              </Field>
              <Field label="Replacement ETA">
                <Input type="date" value={replacementEta} min={todayISO()} onChange={(e) => setReplacementEta(e.target.value)} />
              </Field>
            </div>
          </div>
        ) : null}

        {action === 'remove' ? (
          <Field label="Supplier return reference" hint="Recorded on the removal event for traceability.">
            <Input value={returnRef} onChange={(e) => setReturnRef(e.target.value)} placeholder="RMA-2026-0031" />
          </Field>
        ) : null}

        {action === 'fit' ? (
          <div className="space-y-3">
            <Field label="Replacement unit" hint="Only needed when the disposition did not already resolve one, or to substitute a spare.">
              <Select value={replacementId} onChange={(e) => setReplacementId(e.target.value)}>
                <option value="">Use resolved disposition</option>
                {unitList.filter((u) => u.id !== d.parent_unit_id).map((u) => (
                  <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'}{u.is_spare ? ' · spare' : ''}</option>
                ))}
              </Select>
            </Field>
            <Field label="Fitted at" hint="Defaults to now. A retest must be performed after this moment.">
              <Input type="datetime-local" value={fittedAt} onChange={(e) => setFittedAt(e.target.value)} />
            </Field>
          </div>
        ) : null}

        {action === 'release' ? (
          <div className="space-y-3">
            {passingRetests.length === 0 ? (
              <Callout tone="warning" title="No passing retest">
                Record a passing RETEST, FAT, SAT or commissioning test for this parent before releasing the case.
              </Callout>
            ) : null}
            <Field label="Retest" required>
              <Select value={retestId} onChange={(e) => setRetestId(e.target.value)}>
                <option value="">Select a passing test</option>
                {passingRetests.map((t) => (
                  <option key={t.id} value={t.id}>{t.test_type} · {t.test_ref} · {new Date(t.performed_at).toLocaleString()}</option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-muted-foreground">Releasing sets the parent quality status to PASSED, condition GOOD and returns it to RECEIVED.</p>
          </div>
        ) : null}

        {action === 'close' ? (
          <div className="space-y-3">
            <Field label="Recovery cost" hint="Optional. When supplied, an ACTUAL cost event is recorded against the parent unit.">
              <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="1250.00" />
            </Field>
            <Field label="Currency">
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
            </Field>
          </div>
        ) : null}
      </CommandDialog>

      <Dialog
        open={retestOpen}
        onOpenChange={setRetestOpen}
        title="Record a test"
        description="Tests are immutable. A failing retest leaves the case in RETEST_REQUIRED."
        footer={
          <>
            <Button onClick={() => setRetestOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={recordRetest.isPending} disabled={!testRef.trim()} onClick={() => recordRetest.mutate()}>
              Record test
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Test type" required>
              <Select value={testType} onChange={(e) => setTestType(e.target.value)}>
                {TEST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Result" required>
              <Select value={testResult} onChange={(e) => setTestResult(e.target.value)}>
                <option value="PASS">Pass</option>
                <option value="FAIL">Fail</option>
              </Select>
            </Field>
            <Field label="Test reference" required>
              <Input value={testRef} onChange={(e) => setTestRef(e.target.value)} placeholder="RT-2026-0088" />
            </Field>
            <Field label="Performed at" hint="Defaults to now.">
              <Input type="datetime-local" value={testAt} onChange={(e) => setTestAt(e.target.value)} />
            </Field>
          </div>
        </div>
      </Dialog>

      <p className="mt-4 text-xs text-muted-foreground">
        Need the full asset history? Open the <Link className="text-accent underline-offset-2 hover:underline" to={`/delivery/units/${d.parent_unit_id}`}>parent unit passport</Link>.
      </p>
    </>
  )
}
