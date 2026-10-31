import { Layers } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { assets, costs } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { PhysicalUnit } from '@/api/types'
import { useAppContext } from '@/context/AppContext'
import { EmptyState, ErrorPanel, LoadingBlock, Metric, Money, PageHeader, QueryView, Section } from '@/components/common'
import { Field, Input, Select } from '@/components/ui/form'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList } from '@/lib/utils'

export function Rollup() {
  const c = useAppContext()
  const [params, setParams] = useSearchParams()
  const parentId = params.get('parent_unit_id') ?? ''
  const [search, setSearch] = useState('')

  const units = useApi(['delivery', 'units', 'rollup'], assets.units({ programme_id: c.programmeId ?? null, include_components: true }), { staleTime: 60_000 })
  const unitList = useMemo(() => asList<PhysicalUnit>(units.data), [units.data])
  const visible = unitList.filter((u) => !search.trim() || `${u.asset_code} ${u.item_code ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  const q = useApi(['costs', 'rollup', parentId], costs.rollup(parentId), { enabled: !!parentId })

  const select = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('parent_unit_id', id)
    else next.delete('parent_unit_id')
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        eyebrow="Cost intelligence"
        title="Structure rollup"
        description="Rolls recognized and provisional cost across every fitted component, using the structure at the current date. Direct cost on the parent stays separate."
      />

      <Section
        title="Parent structure"
        description="Choose an assembled parent. Leaf costs are summed per component; nothing is double-counted."
        actions={
          <Select className="w-64" value={parentId} onChange={(e) => select(e.target.value)} aria-label="Parent unit">
            <option value="">Select parent unit</option>
            {unitList.map((u) => <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'}</option>)}
          </Select>
        }
      >
        {!parentId ? (
          <div className="space-y-3 px-4 py-4">
            <Field label="Search assets">
              <Input
                className="max-w-md"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter the picker by asset code or model"
                aria-label="Search assets"
              />
            </Field>
            <Table caption="Assets for rollup">
              <THead>
                <TR>
                  <TH>Asset</TH>
                  <TH>Model</TH>
                  <TH>State</TH>
                  <TH className="text-right">Select</TH>
                </TR>
              </THead>
              <TBody>
                {visible.length === 0 ? (
                  <EmptyRow cols={4}>No assets match.</EmptyRow>
                ) : (
                  visible.slice(0, 25).map((u) => (
                    <TR key={u.id}>
                      <RowHeader><span className="code">{u.asset_code}</span></RowHeader>
                      <TD>{u.item_code ?? '—'}</TD>
                      <TD>{u.state}</TD>
                      <TD className="text-right">
                        <Link className="text-xs font-medium text-accent underline-offset-2 hover:underline" to={`/costs/rollup?parent_unit_id=${u.id}`}>Roll up</Link>
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </div>
        ) : q.isPending ? (
          <LoadingBlock rows={6} label="Rolling up cost" />
        ) : q.isError ? (
          <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? null : (
          <div className="space-y-4 p-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Parent asset" value={<span className="code text-lg">{q.data.asset_code ?? parentId.slice(0, 8)}</span>} />
              <Metric label="Recognized (leaves)" value={<Money value={q.data.recognized_total} />} tone="success" />
              <Metric label="Provisional (leaves)" value={<Money value={q.data.provisional_total} />} tone="warning" />
              <Metric
                label="Direct on parent"
                value={<Money value={(q.data as { direct_recognized_total?: string }).direct_recognized_total} />}
                tone="info"
                hint="Excludes component leaves"
              />
            </div>
            <QueryView q={q} rows={5} empty={<EmptyState icon={<Layers />} title="No components" message="This unit has no fitted component leaves." />} isEmpty={(r) => (r.leaves ?? []).length === 0}>
              {(r) => (
                <Table caption="Leaf cost by component">
                  <THead>
                    <TR>
                      <TH>Component</TH>
                      <TH>Model</TH>
                      <TH>Slot</TH>
                      <TH numeric>Recognized</TH>
                      <TH numeric>Provisional</TH>
                      <TH className="text-right">Open</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {(r.leaves ?? []).length === 0 ? (
                      <EmptyRow cols={6}>No component leaves.</EmptyRow>
                    ) : (
                      (r.leaves ?? []).map((leaf) => (
                        <TR key={leaf.unit_id}>
                          <RowHeader><span className="code">{leaf.asset_code ?? leaf.unit_id.slice(0, 8)}</span></RowHeader>
                          <TD>{leaf.item_code ?? '—'}</TD>
                          <TD>{leaf.slot_code ?? '—'}</TD>
                          <TD numeric><Money value={leaf.recognized_total} /></TD>
                          <TD numeric><Money value={leaf.provisional_total} /></TD>
                          <TD className="text-right">
                            <Link className="text-xs font-medium text-accent underline-offset-2 hover:underline" to={`/costs/units/${leaf.unit_id}`}>Summary</Link>
                          </TD>
                        </TR>
                      ))
                    )}
                  </TBody>
                </Table>
              )}
            </QueryView>
          </div>
        )}
      </Section>
    </>
  )
}
