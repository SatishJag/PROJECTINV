import { Play, Send, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { integrations } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { OutboxMessage } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { CommandDialog } from '@/components/CommandDialog'
import { JsonView } from '@/components/JsonView'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Callout, DateTimeText, EmptyState, KV, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const STATES = ['PENDING', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN', 'TIMEOUT_UNKNOWN', 'DEAD'] as const

export function Outbox() {
  const s = useSession()
  const [state, setState] = useState('')
  const [view, setView] = useState<OutboxMessage | null>(null)
  const [reconcile, setReconcile] = useState<OutboxMessage | null>(null)
  const [outcome, setOutcome] = useState<'APPLIED' | 'NOT_APPLIED'>('APPLIED')
  const [externalRef, setExternalRef] = useState('')
  const [note, setNote] = useState('')

  const q = useApi(['integrations', 'outbox', state || 'ALL'], integrations.outbox(state || undefined))
  const messages = asList<OutboxMessage>(q.data)
  const unknown = messages.filter((m) => m.state === 'UNKNOWN' || m.state === 'TIMEOUT_UNKNOWN').length

  const retry = useCommand({
    run: (id: string) => integrations.retryOutbox(id),
    invalidate: [['integrations']],
    success: 'Message queued for retry',
  })
  const process = useCommand({
    run: () => integrations.processOutbox(),
    invalidate: [['integrations']],
    success: 'Outbox processed',
  })
  const reconcileCmd = useCommand({
    run: () =>
      reconcile
        ? integrations.reconcileOutbox(reconcile.id, {
            outcome,
            external_ref: externalRef.trim() || null,
            note: note.trim() || null,
          })
        : Promise.resolve(null),
    invalidate: [['integrations']],
    success: outcome === 'APPLIED' ? 'Marked applied in source' : 'Marked not applied in source',
    onSuccess: () => {
      setReconcile(null)
      setExternalRef('')
      setNote('')
    },
  })

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Outbox"
        description="Transactional outbox for writes to Procore, Oracle and Planon. Unknown outcomes require an explicit reconciliation decision."
        actions={
          s.can('integration.manage') ? (
            <Button variant="primary" loading={process.isPending} onClick={() => process.mutate()}><Play aria-hidden /> Process queue</Button>
          ) : null
        }
      />

      {unknown > 0 ? (
        <Callout className="mb-4" tone="danger" title={`${unknown} message${unknown === 1 ? '' : 's'} with unconfirmed outcome`}>
          These messages may or may not have been applied in the target. Check the external system, then reconcile with a reference — never just retry.
        </Callout>
      ) : null}

      <Section
        title={`${messages.length} message${messages.length === 1 ? '' : 's'}`}
        description="Each message carries a dedupe key so retries cannot duplicate an external write."
        actions={
          <Select className="w-52" value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
            <option value="">All states</option>
            {STATES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
          </Select>
        }
      >
        <QueryView q={q} rows={7} empty={<EmptyState icon={<Send />} title="No outbox messages" message="Writes to external systems appear here when commands emit integration events." />}>
          {() => (
            <Table caption="Outbox messages">
              <THead>
                <TR>
                  <TH>Created</TH>
                  <TH>Target</TH>
                  <TH>Event</TH>
                  <TH>Aggregate</TH>
                  <TH>State</TH>
                  <TH numeric>Attempts</TH>
                  <TH>Next attempt</TH>
                  <TH>External ref</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {messages.length === 0 ? (
                  <EmptyRow cols={9}>No messages for this filter.</EmptyRow>
                ) : (
                  messages.map((m) => {
                    const reconcilable = m.state === 'UNKNOWN' || m.state === 'TIMEOUT_UNKNOWN'
                    return (
                      <TR key={m.id}>
                        <RowHeader><DateTimeText value={m.created_at} /></RowHeader>
                        <TD>{m.target}</TD>
                        <TD><span className="code">{m.event_type}</span></TD>
                        <TD>
                          {humanize(m.aggregate_type)}
                          <span className="block text-[11px] text-muted-foreground">{m.aggregate_id.slice(0, 8)}{m.aggregate_version != null ? ` · v${m.aggregate_version}` : ''}</span>
                        </TD>
                        <TD><StateBadge state={m.state} context="outbox" /></TD>
                        <TD numeric>{m.attempts}</TD>
                        <TD><DateTimeText value={m.next_attempt_at} /></TD>
                        <TD>{m.external_ref ? <span className="code">{m.external_ref}</span> : <span className="text-muted-foreground">—</span>}</TD>
                        <TD className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button size="sm" onClick={() => setView(m)}>Review</Button>
                            {s.can('integration.manage') && reconcilable ? (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                  setReconcile(m)
                                  setOutcome('APPLIED')
                                  setExternalRef('')
                                  setNote('')
                                }}
                              >
                                Reconcile
                              </Button>
                            ) : null}
                            {s.can('integration.manage') && !reconcilable ? (
                              <Button size="sm" loading={retry.isPending && retry.variables === m.id} onClick={() => retry.mutate(m.id)}>
                                <RotateCcw aria-hidden /> Retry
                              </Button>
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
        open={!!view}
        onOpenChange={(o) => !o && setView(null)}
        title={view ? `Message ${view.id.slice(0, 8)}` : 'Message'}
        description={view ? `${view.target} · ${view.event_type}` : undefined}
        size="lg"
      >
        {view ? (
          <div className="space-y-3">
            <KV
              cols={2}
              items={[
                { label: 'State', value: <StateBadge state={view.state} context="outbox" /> },
                { label: 'Attempts', value: view.attempts },
                { label: 'Dedupe key', value: <span className="code">{view.dedup_key}</span> },
                { label: 'Correlation', value: <span className="code">{view.correlation_id ?? '—'}</span> },
                { label: 'External ref', value: view.external_ref ?? '—' },
                { label: 'Processed', value: <DateTimeText value={view.processed_at} /> },
              ]}
            />
            {view.last_error ? <Callout tone="danger" title="Last error">{view.last_error}</Callout> : null}
            <JsonView label="Payload" value={view.payload} defaultOpen />
          </div>
        ) : null}
      </Dialog>

      <CommandDialog
        open={!!reconcile}
        onOpenChange={(o) => {
          if (!o) setReconcile(null)
        }}
        title="Reconcile unknown outcome"
        description="Choose what actually happened in the source system. This closes the ambiguity and prevents a duplicate write."
        tone="danger"
        confirmLabel="Record reconciliation"
        run={() => reconcileCmd.mutateAsync(undefined)}
        invalidate={[['integrations']]}
        success="Outbox message reconciled"
        onDone={() => setReconcile(null)}
        disabled={!reconcile ? 'Select a message.' : undefined}
      >
        <div className="space-y-3">
          {reconcile ? (
            <>
              <KV
                cols={2}
                items={[
                  { label: 'Target', value: reconcile.target },
                  { label: 'Event', value: <span className="code">{reconcile.event_type}</span> },
                  { label: 'Attempts', value: reconcile.attempts },
                  { label: 'Last error', value: reconcile.last_error ?? '—' },
                ]}
              />
              <Field label="Outcome" required>
                <Select value={outcome} onChange={(e) => setOutcome(e.target.value as 'APPLIED' | 'NOT_APPLIED')}>
                  <option value="APPLIED">Applied in source</option>
                  <option value="NOT_APPLIED">Not applied in source</option>
                </Select>
              </Field>
              <Field label="External reference" hint="The id returned by the external system, when applied.">
                <Input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="PROCORE-COMMITMENT-1290" />
              </Field>
              <Field label="Note" hint="Evidence for the decision is stored with the audit record.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </>
          ) : null}
        </div>
      </CommandDialog>
    </>
  )
}
