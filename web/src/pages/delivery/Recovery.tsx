import { Link } from 'react-router'
import { AlertTriangle, ArrowUpRight, Plus, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { assets, quality } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { PhysicalUnit, RecoveryCase } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Callout, DateText, EmptyState, Metric, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const STATES = ['OPEN', 'DISPOSITIONED', 'COMPONENT_REMOVED', 'RETEST_REQUIRED', 'RELEASED', 'CLOSED'] as const
const STAGES = ['SUPPLIER_FACTORY', 'SITE_RECEIPT', 'INSTALLATION', 'COMMISSIONING', 'IN_SERVICE'] as const

export function Recovery() {
  const s = useSession()
  const c = useAppContext()
  const [state, setState] = useState('')
  const [open, setOpen] = useState(false)
  const [ncr, setNcr] = useState('')
  const [parentId, setParentId] = useState('')
  const [slot, setSlot] = useState('')
  const [stage, setStage] = useState<string>('SUPPLIER_FACTORY')
  const [description, setDescription] = useState('')

  const q = useApi(['quality', 'recovery', state || 'ALL'], quality.recoveryCases(state || undefined))
  const units = useApi(['delivery', 'units', 'recovery-picker'], assets.units({ programme_id: c.programmeId ?? null, include_components: true }), { enabled: open })
  const unitList = useMemo(() => asList<PhysicalUnit>(units.data), [units.data])

  const cases = asList<RecoveryCase>(q.data)
  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const cc of cases) m[cc.state] = (m[cc.state] ?? 0) + 1
    return m
  }, [cases])
  const openCases = cases.filter((cc) => !['RELEASED', 'CLOSED'].includes(cc.state)).length

  const create = useCommand({
    run: () =>
      quality.createRecoveryCase({
        ncr_number: ncr.trim(),
        parent_unit_id: parentId,
        slot_code: slot.trim() || null,
        failure_stage: stage,
        description: description.trim(),
      }),
    invalidate: [['quality']],
    success: (row) => `NCR ${row.ncr_number} opened`,
    onSuccess: () => {
      setOpen(false)
      setNcr('')
      setParentId('')
      setSlot('')
      setDescription('')
    },
  })

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="FAT & recovery"
        description="Factory and site test failures open a non-conformance. Every route — repair, spare or donor — records its project impacts before the parent can be released."
        actions={
          s.can('recovery.manage') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus aria-hidden /> Open NCR
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Cases in view" value={cases.length} />
        <Metric label="Open work" value={openCases} tone={openCases ? 'danger' : 'success'} hint="Not yet released or closed" />
        <Metric label="Awaiting release" value={counts.RETEST_REQUIRED ?? 0} tone="warning" hint="Replacement fitted; retest required" />
        <Metric label="Released" value={(counts.RELEASED ?? 0) + (counts.CLOSED ?? 0)} tone="success" />
      </div>

      <Section
        title="Non-conformance register"
        description="The failed component is referenced by slot, never replaced by inference. Impacts are listed on each case."
        actions={
          <Select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
            <option value="">All states</option>
            {STATES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
          </Select>
        }
      >
        <QueryView
          q={q}
          rows={6}
          empty={<EmptyState icon={<ShieldAlert />} title="No recovery cases" message="Failed factory or site tests appear here once recorded." />}
          isEmpty={() => cases.length === 0 && !!state}
        >
          {() => (
            <Table caption="Recovery cases">
              <THead>
                <TR>
                  <TH>NCR</TH>
                  <TH>Asset</TH>
                  <TH>Failure stage</TH>
                  <TH>State</TH>
                  <TH>Route</TH>
                  <TH>Responsible</TH>
                  <TH>Expected completion</TH>
                  <TH className="text-right">Open</TH>
                </TR>
              </THead>
              <TBody>
                {cases.length === 0 ? (
                  <EmptyRow cols={8}>No recovery cases for this filter.</EmptyRow>
                ) : (
                  cases.map((cc) => (
                    <TR key={cc.id}>
                      <RowHeader>
                        <Link className="code text-accent underline-offset-2 hover:underline" to={`/delivery/recovery/${cc.id}`}>
                          {cc.ncr_number}
                        </Link>
                      </RowHeader>
                      <TD><span className="code">{cc.parent_asset_code ?? cc.parent_unit_id.slice(0, 8)}</span></TD>
                      <TD>{humanize(cc.failure_stage)}</TD>
                      <TD><StateBadge state={cc.state} /></TD>
                      <TD>{cc.route ? humanize(cc.route) : <span className="text-muted-foreground">Not dispositioned</span>}</TD>
                      <TD>{cc.responsible_party ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD><DateText value={cc.expected_completion} /></TD>
                      <TD className="text-right">
                        <Link className="inline-flex items-center gap-1 text-xs text-accent underline-offset-2 hover:underline" to={`/delivery/recovery/${cc.id}`}>
                          Review <ArrowUpRight className="size-3" aria-hidden />
                        </Link>
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      {openCases > 0 ? (
        <Callout className="mt-3" tone="warning" icon={<AlertTriangle />} title={`${openCases} case${openCases === 1 ? '' : 's'} not released`}>
          A parent unit stays on hold until a passing retest is recorded and the case is released by Engineering.
        </Callout>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Open a non-conformance"
        description="Record the failed test against the parent structure and the slot that must be recovered."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!ncr.trim() || !parentId || !description.trim()}
              onClick={() => create.mutate()}
            >
              Open NCR
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="NCR number" required hint="Unique per tenant; for example NCR-2026-0014.">
              <Input value={ncr} onChange={(e) => setNcr(e.target.value.toUpperCase())} placeholder="NCR-2026-0014" />
            </Field>
            <Field label="Parent unit" required hint="The assembled structure that failed.">
              <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Select unit</option>
                {unitList.map((u) => (
                  <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'} · {u.state.replace('_', ' ')}</option>
                ))}
              </Select>
            </Field>
            <Field label="Slot code" hint="Required for replacement or donor routes.">
              <Input value={slot} onChange={(e) => setSlot(e.target.value.toUpperCase())} placeholder="SLOT-A" />
            </Field>
            <Field label="Failure stage" required>
              <Select value={stage} onChange={(e) => setStage(e.target.value)}>
                {STAGES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description" required>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Observed failure, measurement and test reference." />
          </Field>
          {units.isPending ? <p className="text-xs text-muted-foreground">Loading units…</p> : null}
        </div>
      </Dialog>
    </>
  )
}
