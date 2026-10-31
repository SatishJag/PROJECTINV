import { ArrowLeft, Ban } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { procurement } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { PoLine } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/form'
import { DateText, DateTimeText, EmptyState, IdentityBand, KV, Money, Mono, PageHeader, Qty, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'

export function PurchaseOrderDetail() {
  const { poId = '' } = useParams()
  const s = useSession()
  const q = useApi(['procurement', 'purchase-order', poId], procurement.purchaseOrder(poId))
  const [cancelLine, setCancelLine] = useState<PoLine | null>(null)
  const [qty, setQty] = useState('1')

  const cancel = useCommand({
    run: () => procurement.cancelQuantity(poId, { po_line_id: cancelLine?.id ?? '', quantity: qty }),
    invalidate: [['procurement'], ['delivery']],
    success: `Cancelled ${qty} unit(s) and retired their planned serials`,
    onSuccess: () => setCancelLine(null),
  })

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/delivery/purchase-orders" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3" aria-hidden /> Purchase orders</Link>}
        title={q.data ? q.data.po.canonical_number : 'Purchase order'}
        description="Every serialized unit on this order has its own asset record, receipt and source alias."
      />

      <QueryView q={q} rows={5}>
        {(d) => (
          <>
            <IdentityBand
              items={[
                { label: 'PO', value: d.po.canonical_number },
                { label: 'Supplier', value: d.po.supplier_name ?? '—' },
                { label: 'State', value: <StateBadge state={d.po.state} /> },
                { label: 'Currency', value: d.po.currency },
                { label: 'Incoterms', value: d.po.incoterms ?? '—' },
                { label: 'Issued', value: <DateTimeText value={d.po.issued_at} /> },
              ]}
            />
            <div className="grid gap-4 lg:grid-cols-3">
              <Section title="Lines" description="Planned serials are generated at import; cancellations retire them." className="lg:col-span-2">
                <Table caption="Purchase order lines">
                  <THead>
                    <TR>
                      <TH>Line</TH>
                      <TH>Item</TH>
                      <TH numeric>Ordered</TH>
                      <TH numeric>Cancelled</TH>
                      <TH numeric>Unit price</TH>
                      <TH>Need by</TH>
                      <TH numeric>Units</TH>
                      <TH className="text-right">Action</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.lines.length === 0 ? (
                      <EmptyRow cols={8}>No lines.</EmptyRow>
                    ) : (
                      d.lines.map((l) => (
                        <TR key={l.id}>
                          <RowHeader>{l.line_no}</RowHeader>
                          <TD>
                            <span className="code">{l.item_code ?? l.item_model_id.slice(0, 8)}</span>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">{l.uom}</span>
                          </TD>
                          <TD numeric><Qty value={l.quantity} /></TD>
                          <TD numeric>{l.cancelled_quantity}</TD>
                          <TD numeric><Money value={l.unit_price} currency={d.po.currency} /></TD>
                          <TD><DateText value={l.need_by} /></TD>
                          <TD numeric>{l.unit_count ?? 0}</TD>
                          <TD className="text-right">
                            {s.can('po.cancel') && Number(l.quantity) - Number(l.cancelled_quantity) > 0 ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setQty('1')
                                  setCancelLine(l)
                                }}
                              >
                                <Ban aria-hidden /> Cancel
                              </Button>
                            ) : null}
                          </TD>
                        </TR>
                      ))
                    )}
                  </TBody>
                </Table>
                {d.lines.some((l) => (l.distributions ?? []).length) ? (
                  <div className="border-t p-3">
                    <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Distributions</p>
                    <ul className="space-y-1 text-xs">
                      {d.lines.flatMap((l) =>
                        (l.distributions ?? []).map((dist) => (
                          <li key={dist.id}>
                            Line {l.line_no} → {dist.project_code ?? 'Unassigned'} · <Qty value={dist.quantity} /> {dist.requirement_code ? `· ${dist.requirement_code}` : ''}
                          </li>
                        )),
                      )}
                    </ul>
                  </div>
                ) : null}
              </Section>

              <Section title="Order facts">
                <div className="p-4">
                  <KV
                    cols={2}
                    items={[
                      { label: 'Programme', value: (d.po as { programme_code?: string }).programme_code ?? '—' },
                      { label: 'Award', value: d.po.award_id ? <Mono>{d.po.award_id}</Mono> : 'Imported' },
                      { label: 'Aliases', value: d.aliases.length },
                      { label: 'Units', value: d.units.length },
                      { label: 'Created', value: <DateTimeText value={d.po.created_at} /> },
                      { label: 'Source aliases', value: 'GEP · Oracle · Procore' },
                    ]}
                  />
                  {d.aliases.length ? (
                    <ul className="mt-3 space-y-1 border-t pt-2 text-xs">
                      {d.aliases.map((a) => (
                        <li key={a.id}><span className="font-medium">{a.source_system}</span> · <Mono>{a.source_number}</Mono></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </Section>
            </div>

            <Section className="mt-4" title={`Serialized units (${d.units.length})`} description="A unit passport records custody, condition, tests, costs and its Procore mapping.">
              {d.units.length === 0 ? (
                <EmptyState title="No units yet" message="Units are created when the supplier acknowledgement is imported." />
              ) : (
                <Table caption="Units on this purchase order">
                  <THead>
                    <TR>
                      <TH>Asset</TH>
                      <TH>Serial</TH>
                      <TH>State</TH>
                      <TH>Allocation</TH>
                      <TH>Custody</TH>
                      <TH>Condition</TH>
                      <TH>Project</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.units.map((u) => (
                      <TR key={u.id}>
                        <RowHeader><Link className="code text-accent hover:underline" to={`/delivery/units/${u.id}`}>{u.asset_code}</Link></RowHeader>
                        <TD><Mono>{u.serial_number}</Mono></TD>
                        <TD><StateBadge state={u.state} /></TD>
                        <TD><StateBadge state={u.allocation_status} context="allocation" /></TD>
                        <TD>{u.custody_code ?? '—'}</TD>
                        <TD><StateBadge state={u.condition} /></TD>
                        <TD>{u.project_code ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Section>
          </>
        )}
      </QueryView>

      <Dialog
        open={!!cancelLine}
        onOpenChange={(o) => !o && setCancelLine(null)}
        title={`Cancel quantity on line ${cancelLine?.line_no ?? ''}`}
        description="Cancelled serials move to CANCELLED and are excluded from receiving and allocation."
        footer={
          <>
            <Button onClick={() => setCancelLine(null)}>Keep quantity</Button>
            <Button variant="danger" loading={cancel.isPending} disabled={!qty || Number(qty) <= 0} onClick={() => cancel.mutate()}>
              Cancel quantity
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Quantity to cancel" required hint={`Remaining: ${Number(cancelLine?.quantity ?? 0) - Number(cancelLine?.cancelled_quantity ?? 0)} ${cancelLine?.uom ?? ''}`}>
            <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  )
}
