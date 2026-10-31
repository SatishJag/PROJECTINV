import { FileInput, PackageOpen } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { procurement, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { PurchaseOrder } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { DateTimeText, EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, cn } from '@/lib/utils'

const SAMPLE = JSON.stringify(
  {
    lines: [
      {
        line_no: 1,
        item_code: 'CHILLER-1200',
        option_code: 'CHILLER-1200-STD',
        quantity: '2',
        uom: 'EA',
        unit_price: '240000',
        need_by: '2027-04-15',
        distributions: [{ project_id: null, quantity: '2' }],
      },
    ],
  },
  null,
  2,
)

export function PurchaseOrders() {
  const s = useSession()
  const c = useAppContext()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [sourceSystem, setSourceSystem] = useState('ORACLE')
  const [sourceNumber, setSourceNumber] = useState('')
  const [canonical, setCanonical] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [programmeId, setProgrammeId] = useState(c.programmeId ?? '')
  const [incoterms, setIncoterms] = useState('DAP')
  const [json, setJson] = useState(SAMPLE)
  const [err, setErr] = useState<string | null>(null)

  const q = useApi(['procurement', 'purchase-orders'], procurement.purchaseOrders)
  const suppliers = useApi(['ref', 'suppliers'], reference.suppliers, { staleTime: 10 * 60_000 })

  const imp = useCommand({
    run: (lines: Record<string, unknown>[]) =>
      procurement.importPo({
        source_system: sourceSystem,
        source_number: sourceNumber.trim(),
        canonical_number: canonical.trim() || undefined,
        supplier_id: supplierId,
        programme_id: programmeId,
        incoterms,
        lines,
      }),
    invalidate: [['procurement'], ['delivery']],
    success: (po) => `Purchase order ${po.po.canonical_number} imported`,
    onSuccess: (po) => {
      setOpen(false)
      nav(`/delivery/purchase-orders/${po.po.id}`)
    },
  })

  function submit() {
    setErr(null)
    try {
      const parsed = JSON.parse(json) as { lines?: unknown }
      if (!Array.isArray(parsed.lines)) {
        setErr('The document must contain a “lines” array.')
        return
      }
      imp.mutate(parsed.lines as Record<string, unknown>[])
    } catch {
      setErr('This is not valid JSON.')
    }
  }

  const rows = asList<PurchaseOrder>(q.data)

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Purchase orders"
        description="Canonical purchase orders with aliases from GEP, Oracle and Procore. Unit serials are created per line."
        actions={
          s.can('po.import') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <FileInput aria-hidden /> Import PO
            </Button>
          ) : null
        }
      />

      <Section title={`${rows.length} purchase order${rows.length === 1 ? '' : 's'}`} description="The canonical number is stable across source systems.">
        <QueryView q={q} rows={6} empty={<EmptyState icon={<PackageOpen />} title="No purchase orders" message="An approved award creates a purchase order, or import one from Oracle, GEP or Procore." />}>
          {() => (
            <Table caption="Purchase orders">
              <THead>
                <TR>
                  <TH>PO</TH>
                  <TH>Supplier</TH>
                  <TH>State</TH>
                  <TH>Currency</TH>
                  <TH>Incoterms</TH>
                  <TH numeric>Units</TH>
                  <TH>Issued</TH>
                  <TH>Aliases</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={8}>No purchase orders.</EmptyRow>
                ) : (
                  rows.map((po) => (
                    <TR key={po.id} className="cursor-pointer" onClick={() => nav(`/delivery/purchase-orders/${po.id}`)}>
                      <RowHeader><span className="code">{po.canonical_number}</span></RowHeader>
                      <TD>{po.supplier_name ?? '—'}</TD>
                      <TD><StateBadge state={po.state} /></TD>
                      <TD>{po.currency}</TD>
                      <TD>{po.incoterms ?? '—'}</TD>
                      <TD numeric>{po.unit_count ?? '—'}</TD>
                      <TD><DateTimeText value={po.issued_at} /></TD>
                      <TD className="max-w-[260px]">
                        <div className="flex flex-wrap gap-1">
                          {(po.aliases ?? []).map((a) => (
                            <span key={a.id} className="code rounded bg-muted px-1 py-0.5 text-[10px]" title={a.source_system}>
                              {a.source_system}: {a.source_number}
                            </span>
                          ))}
                        </div>
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
        title="Import purchase order"
        description="The source number is idempotent. Re-importing the same source number returns the existing PO and adds a new alias."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={imp.isPending} disabled={!sourceNumber.trim() || !supplierId || !programmeId} onClick={submit}>
              Import
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className={cn('grid gap-3 sm:grid-cols-2')}>
            <Field label="Source system" required>
              <Select value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)}>
                {['ORACLE', 'GEP', 'PROCORE'].map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="Source number" required>
              <Input value={sourceNumber} onChange={(e) => setSourceNumber(e.target.value)} placeholder="ORACLE-PO-506123" />
            </Field>
            <Field label="Canonical number" hint="Defaults to the source number.">
              <Input value={canonical} onChange={(e) => setCanonical(e.target.value)} placeholder="PCX-PO-000123" />
            </Field>
            <Field label="Supplier" required>
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Select supplier</option>
                {(suppliers.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>{x.key} · {x.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Programme" required>
              <Select value={programmeId} onChange={(e) => setProgrammeId(e.target.value)}>
                <option value="">Select programme</option>
                {c.programmes.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Incoterms">
              <Input value={incoterms} onChange={(e) => setIncoterms(e.target.value)} />
            </Field>
          </div>
          <Field label="Lines (JSON object with “lines”)" required error={err} hint="Line keys: line_no, item_code, option_code, quantity, uom, unit_price, need_by, distributions.">
            <Textarea className="min-h-[220px] font-mono text-[11px]" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </>
  )
}

