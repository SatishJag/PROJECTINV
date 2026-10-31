import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { integrations } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { IntegrationException } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { CommandDialog } from '@/components/CommandDialog'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const STATES = ['OPEN', 'RESOLVED', 'IGNORED'] as const

export function Exceptions() {
  const s = useSession()
  const [state, setState] = useState('OPEN')
  const [target, setTarget] = useState<IntegrationException | null>(null)

  const q = useApi(['integrations', 'exceptions', state || 'ALL'], integrations.exceptions(state || undefined))
  const rows = asList<IntegrationException>(q.data)

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Integration exceptions"
        description="Blocked flows that need a human decision: mapping conflicts, rejected writes, unmatched vendor or cost code references."
      />

      <Section
        title={`${rows.length} exception${rows.length === 1 ? '' : 's'}`}
        description="Resolution is recorded with your identity and becomes part of the audit trail."
        actions={
          <Select className="w-44" value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
            <option value="">All states</option>
            {STATES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
          </Select>
        }
      >
        <QueryView q={q} rows={6} empty={<EmptyState icon={<ShieldAlert />} title="No exceptions" message="Nothing is blocked. Rejected or ambiguous integration events appear here." />}>
          {() => (
            <Table caption="Integration exceptions">
              <THead>
                <TR>
                  <TH>Opened</TH>
                  <TH>Source</TH>
                  <TH>Kind</TH>
                  <TH>Subject</TH>
                  <TH>Message</TH>
                  <TH>Owner</TH>
                  <TH>State</TH>
                  <TH>Resolution</TH>
                  <TH className="text-right">Action</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={9}>No exceptions for this filter.</EmptyRow>
                ) : (
                  rows.map((e) => (
                    <TR key={e.id}>
                      <RowHeader><DateTimeText value={e.created_at} /></RowHeader>
                      <TD>{e.source}</TD>
                      <TD>{humanize(e.kind)}</TD>
                      <TD>
                        {e.subject_type ? humanize(e.subject_type) : '—'}
                        {e.subject_id ? <span className="block code text-[11px]">{e.subject_id.slice(0, 8)}</span> : null}
                      </TD>
                      <TD className="max-w-[26rem]">{e.message}</TD>
                      <TD>{humanize(e.owner_role)}</TD>
                      <TD><StateBadge state={e.state} /></TD>
                      <TD className="max-w-[18rem] text-xs text-muted-foreground">{e.resolution ?? '—'}</TD>
                      <TD className="text-right">
                        {e.state === 'OPEN' && s.can('integration.manage') ? (
                          <Button size="sm" variant="primary" onClick={() => setTarget(e)}>Resolve</Button>
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

      <p className="mt-3 text-xs text-muted-foreground">
        Rejected outbound writes stay visible in the <Link className="text-accent underline-offset-2 hover:underline" to="/admin/outbox">outbox</Link>. Inbound handler failures are shown in the{' '}
        <Link className="text-accent underline-offset-2 hover:underline" to="/admin/inbox">webhook inbox</Link>.
      </p>

      <CommandDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Resolve exception"
        description="Describe the corrective action. The exception closes; the underlying records must be fixed separately."
        confirmLabel="Resolve"
        reason={{ label: 'Resolution', required: true, placeholder: 'Mapped vendor 4471 to supplier AC-009 after checking the Procore record.', hint: 'Stored on the exception and audit log.' }}
        run={(resolution) => (target ? integrations.resolveException(target.id, resolution) : Promise.resolve(null))}
        invalidate={[['integrations']]}
        success="Exception resolved"
        onDone={() => setTarget(null)}
      >
        {target ? (
          <div className="space-y-2">
            <p className="text-[13px] font-medium">{humanize(target.kind)} · {target.source}</p>
            <p className="text-[13px] text-foreground/85">{target.message}</p>
            <p className="text-xs text-muted-foreground">Owner role {humanize(target.owner_role)} · opened <DateTimeText value={target.created_at} /></p>
          </div>
        ) : null}
      </CommandDialog>
    </>
  )
}
