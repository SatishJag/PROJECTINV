import { Inbox as InboxIcon, Play } from 'lucide-react'
import { useState } from 'react'
import { integrations } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { InboxMessage } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { JsonView } from '@/components/JsonView'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Select } from '@/components/ui/form'
import { Callout, DateTimeText, EmptyState, KV, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const STATES = ['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED', 'DUPLICATE'] as const

export function Inbox() {
  const s = useSession()
  const [state, setState] = useState('')
  const [view, setView] = useState<InboxMessage | null>(null)

  const q = useApi(['integrations', 'inbox', state || 'ALL'], (signal) =>
    integrations.inbox(signal).then((rows) => (state ? rows.filter((m) => m.state === state) : rows)),
  )
  const messages = asList<InboxMessage>(q.data)
  const process = useCommand({
    run: () => integrations.processInbox(),
    invalidate: [['integrations']],
    success: (r) => `${r.processed} inbound event${r.processed === 1 ? '' : 's'} processed`,
  })

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Webhook inbox"
        description="Every inbound Procore webhook is persisted before acknowledgement, deduplicated by event id and payload hash, then processed once."
        actions={
          s.can('integration.manage') ? (
            <Button variant="primary" loading={process.isPending} onClick={() => process.mutate()}><Play aria-hidden /> Process events</Button>
          ) : null
        }
      />

      <Section
        title={`${messages.length} event${messages.length === 1 ? '' : 's'}`}
        description="The inbox is the audit trail for inbound changes; failures become integration exceptions."
        actions={
          <Select className="w-44" value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
            <option value="">All states</option>
            {STATES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
          </Select>
        }
      >
        <QueryView q={q} rows={6} empty={<EmptyState icon={<InboxIcon />} title="No inbound events" message="Procore webhooks land here when the connection is registered." />}>
          {() => (
            <Table caption="Inbound webhook messages">
              <THead>
                <TR>
                  <TH>Received</TH>
                  <TH>Source</TH>
                  <TH>Event type</TH>
                  <TH>Source event</TH>
                  <TH>State</TH>
                  <TH>Processed</TH>
                  <TH>Error</TH>
                  <TH className="text-right">Payload</TH>
                </TR>
              </THead>
              <TBody>
                {messages.length === 0 ? (
                  <EmptyRow cols={8}>No inbound events for this filter.</EmptyRow>
                ) : (
                  messages.map((m) => (
                    <TR key={m.id}>
                      <RowHeader><DateTimeText value={m.created_at} /></RowHeader>
                      <TD>{m.source}</TD>
                      <TD><span className="code">{m.event_type}</span></TD>
                      <TD><span className="code text-[11px]">{m.source_event_id}</span></TD>
                      <TD><StateBadge state={m.state} /></TD>
                      <TD><DateTimeText value={m.processed_at} /></TD>
                      <TD className="max-w-[18rem] text-xs text-danger">{m.error ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD className="text-right">
                        <Button size="sm" onClick={() => setView(m)}>Review</Button>
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <Callout className="mt-3" tone="info" title="Acknowledgement happens after persistence">
        A failed handler keeps the event and raises an exception; it never causes Procore to resend a mutated payload.
      </Callout>

      <Dialog
        open={!!view}
        onOpenChange={(o) => !o && setView(null)}
        title={view ? view.event_type : 'Inbound event'}
        description={view ? `${view.source} · ${view.source_event_id}` : undefined}
        size="lg"
      >
        {view ? (
          <div className="space-y-3">
            <KV
              cols={2}
              items={[
                { label: 'State', value: <StateBadge state={view.state} /> },
                { label: 'Payload hash', value: <span className="code">{view.payload_hash}</span> },
                { label: 'Received', value: <DateTimeText value={view.created_at} /> },
                { label: 'Processed', value: <DateTimeText value={view.processed_at} /> },
              ]}
            />
            {view.error ? <Callout tone="danger" title="Handler error">{view.error}</Callout> : null}
            <JsonView label="Payload" value={view.payload} defaultOpen />
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
