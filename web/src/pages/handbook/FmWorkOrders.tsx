import { AlertTriangle, Import, ReceiptText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { costs } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { FmWorkOrder } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Textarea } from '@/components/ui/form'
import { Callout, DateText, EmptyState, Money, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList } from '@/lib/utils'

const SAMPLE = JSON.stringify(
  {
    work_orders: [
      {
        work_order_ref: 'WO-2026-0091',
        invoice_ref: 'INV-PL-8842',
        planon_asset_id: 'PLN-10023',
        service_from: '2026-06-01',
        service_to: '2026-06-30',
        description: 'Quarterly generator service',
        amount: '1450.00',
        currency: 'USD',
        posting_project_id: null,
      },
    ],
  },
  null,
  2,
)

export function FmWorkOrders() {
  const s = useSession()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState(SAMPLE)
  const [parseError, setParseError] = useState<string | null>(null)

  const q = useApi(['costs', 'fm'], costs.fmWorkOrders)
  const rows = asList<FmWorkOrder>(q.data)
  const unresolved = useMemo(() => rows.filter((w) => w.state === 'UNRESOLVED'), [rows])

  const runImport = async () => {
    setParseError(null)
    let body: { work_orders: Record<string, unknown>[] }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { work_orders?: unknown }).work_orders)) {
        throw new Error('Expected an object with a "work_orders" array.')
      }
      body = parsed as { work_orders: Record<string, unknown>[] }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON')
      throw e
    }
    return costs.importFm(body)
  }

  const importWo = useCommand({
    run: runImport,
    invalidate: [['costs']],
    success: 'Work orders imported',
    onSuccess: () => setOpen(false),
  })

  return (
    <>
      <PageHeader
        eyebrow="Handbook & operations"
        title="FM work orders"
        description="Planon service invoices resolve to the unit that occupied the parent/slot on the service date. Unresolved lines stay visible — never guessed."
        actions={
          s.can('fm.import') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Import aria-hidden /> Import work orders
            </Button>
          ) : null
        }
      />

      {unresolved.length > 0 ? (
        <Callout className="mb-4" tone="warning" icon={<AlertTriangle />} title={`${unresolved.length} unresolved work order${unresolved.length === 1 ? '' : 's'}`}>
          No fitted component matched the parent/slot at the service date. Correct the Planon identifier or record the fitting history first.
        </Callout>
      ) : null}

      <Section title={`${rows.length} work order${rows.length === 1 ? '' : 's'}`} description="Imports are idempotent on source system + work order + invoice.">
        <QueryView q={q} rows={6} empty={<EmptyState icon={<ReceiptText />} title="No work orders" message="Import the Planon export to attribute service cost to units and projects." />}>
          {() => (
            <Table caption="FM work orders">
              <THead>
                <TR>
                  <TH>Work order</TH>
                  <TH>Invoice</TH>
                  <TH>Asset</TH>
                  <TH>Service period</TH>
                  <TH>Description</TH>
                  <TH numeric>Amount</TH>
                  <TH numeric>Unallocated</TH>
                  <TH>State</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={8}>No work orders imported.</EmptyRow>
                ) : (
                  rows.map((w) => (
                    <TR key={w.id}>
                      <RowHeader><span className="code">{w.work_order_ref}</span></RowHeader>
                      <TD><span className="code">{w.invoice_ref}</span></TD>
                      <TD>
                        {w.resolved_asset_code ?? <span className="text-muted-foreground">{w.planon_asset_id ?? 'Unmapped'}</span>}
                        {w.slot_code ? <span className="ml-1 text-[11px] text-muted-foreground">· {w.slot_code}</span> : null}
                      </TD>
                      <TD>
                        <DateText value={w.service_from} /> – <DateText value={w.service_to} />
                      </TD>
                      <TD className="max-w-[24rem]">{w.description}</TD>
                      <TD numeric><Money value={w.amount} currency={w.currency} /></TD>
                      <TD numeric><Money value={w.unallocated_amount} currency={w.currency} /></TD>
                      <TD>
                        <StateBadge state={w.state} />
                        {w.resolution_note ? <p className="mt-0.5 max-w-[16rem] text-[11px] text-muted-foreground">{w.resolution_note}</p> : null}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Import Planon work orders"
        description="Paste the export object. Each row needs work_order_ref, invoice_ref, service dates and an amount."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={importWo.isPending} onClick={() => importWo.mutate()}>Import</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Work orders JSON" required error={parseError ?? undefined} hint="A resolved line creates an ACTUAL SERVICE cost event and an allocation to the project at the service date.">
            <Textarea className="min-h-[280px] font-mono text-[11px]" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </>
  )
}
