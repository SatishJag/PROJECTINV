import { History, Search } from 'lucide-react'
import { useState } from 'react'
import { dashboard } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { AuditEvent } from '@/api/types'
import { JsonView } from '@/components/JsonView'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, KV, PageHeader, QueryView, Section } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const SUBJECTS = [
  'requirement',
  'requirement_revision',
  'sourcing_package',
  'supplier_offer',
  'evaluation',
  'award',
  'purchase_order',
  'physical_unit',
  'recovery_case',
  'handbook_package',
  'integration_exception',
  'tco_scenario',
  'cost_event',
  'procore_connection',
] as const

const LIMIT = 50

export function AuditLog() {
  const [subjectType, setSubjectType] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [appliedId, setAppliedId] = useState('')
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState<AuditEvent | null>(null)

  const q = useApi(['audit', subjectType, appliedId, offset], dashboard.audit({ subject_type: subjectType || undefined, subject_id: appliedId || undefined, limit: LIMIT, offset }),
  )
  const rows = asList<AuditEvent>(q.data)

  const apply = () => {
    setOffset(0)
    setAppliedId(subjectId.trim())
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Audit log"
        description="Who did what, to which record, with before and after state. Every guarded command appends an immutable entry; reasons are stored when required."
      />

      <Section title="Filters" description="Filter by subject type or a specific record id.">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Subject type">
            <Select
              value={subjectType}
              onChange={(e) => {
                setSubjectType(e.target.value)
                setOffset(0)
              }}
            >
              <option value="">Any subject</option>
              {SUBJECTS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
            </Select>
          </Field>
          <Field label="Subject id" hint="Exact internal record id.">
            <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="a1b2c3…" onKeyDown={(e) => { if (e.key === 'Enter') apply() }} />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" onClick={apply}><Search aria-hidden /> Apply</Button>
          </div>
        </div>
      </Section>

      <Section
        className="mt-4"
        title="Events"
        description={`Showing ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} from offset ${offset}.`}
        actions={
          <div className="flex gap-1">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</Button>
            <Button size="sm" disabled={rows.length < LIMIT} onClick={() => setOffset(offset + LIMIT)}>Next</Button>
          </div>
        }
      >
        <QueryView q={q} rows={8} empty={<EmptyState icon={<History />} title="No audit entries" message="Commands append entries here as they are executed." />}>
          {() => (
            <Table caption="Audit events">
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Subject</TH>
                  <TH>Reason</TH>
                  <TH>Correlation</TH>
                  <TH className="text-right">Detail</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={7}>No entries for this filter.</EmptyRow>
                ) : (
                  rows.map((e) => (
                    <TR key={e.id}>
                      <RowHeader><DateTimeText value={e.at} /></RowHeader>
                      <TD>
                        {e.actor}
                        {e.actor_roles ? <span className="block text-[11px] text-muted-foreground">{e.actor_roles}</span> : null}
                      </TD>
                      <TD><span className="code text-[11px]">{e.action}</span></TD>
                      <TD>
                        {humanize(e.subject_type)}
                        <span className="block text-[11px] text-muted-foreground">{e.subject_id.slice(0, 10)}</span>
                      </TD>
                      <TD className="max-w-[20rem] text-xs">{e.reason ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD><span className="code text-[11px]">{e.correlation_id ?? '—'}</span></TD>
                      <TD className="text-right"><Button size="sm" onClick={() => setView(e)}>Inspect</Button></TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <Dialog
        open={!!view}
        onOpenChange={(o) => !o && setView(null)}
        title={view ? view.action : 'Audit entry'}
        description={view ? `${view.actor} · ${humanize(view.subject_type)} ${view.subject_id.slice(0, 10)}` : undefined}
        size="lg"
      >
        {view ? (
          <div className="space-y-3">
            <KV
              cols={2}
              items={[
                { label: 'When', value: <DateTimeText value={view.at} /> },
                { label: 'Actor roles', value: view.actor_roles ?? '—' },
                { label: 'Correlation', value: <span className="code">{view.correlation_id ?? '—'}</span> },
                { label: 'Reason', value: view.reason ?? '—' },
              ]}
            />
            {view.before ? <JsonView label="Before" value={view.before} /> : null}
            {view.after ? <JsonView label="After" value={view.after} defaultOpen /> : null}
            {!view.before && !view.after ? <p className="text-xs text-muted-foreground">No state snapshots were recorded for this command.</p> : null}
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
