import { Warehouse } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { inventory, reference } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import { useAppContext } from '@/context/AppContext'
import { Select } from '@/components/ui/form'
import { EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'

export function Stock() {
  const c = useAppContext()
  const nav = useNavigate()
  const [locationId, setLocationId] = useState('')
  const [projectId, setProjectId] = useState(c.projectId ?? '')
  const locations = useApi(['ref', 'locations'], reference.locations, { staleTime: 10 * 60_000 })
  const q = useApi(['delivery', 'stock', c.programmeId ?? 'all', locationId, projectId], inventory.stock({ programme_id: c.programmeId ?? null, location_id: locationId || null, project_id: projectId || null }),
  )

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Stock by custody"
        description="Every unit has exactly one custody location. Allocation status is separate from physical custody."
        actions={
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Location
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-48">
                <option value="">All locations</option>
                {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code} · {l.kind.replace('_', ' ')}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Project
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-40">
                <option value="">All projects</option>
                {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
              </Select>
            </label>
          </div>
        }
      />

      <QueryView
        q={q}
        rows={5}
        empty={<EmptyState icon={<Warehouse />} title="No stock in this scope" message="Received units appear here as soon as the arrival is confirmed." />}
      >
        {(d) => (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {d.by_location.map((loc) => (
                <button
                  key={loc.code}
                  type="button"
                  className="rounded-lg border bg-card px-4 py-3 text-left transition hover:border-accent"
                  onClick={() => setLocationId(loc.location?.id ?? '')}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{loc.code}</p>
                  <p className="mt-0.5 truncate text-[13px] font-medium">{loc.name}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{loc.total}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {loc.unallocated} unallocated · {loc.allocated} intent · {loc.reserved} reserved · {loc.issued} issued
                  </p>
                </button>
              ))}
            </div>

            <Section title={`${d.units.length} unit${d.units.length === 1 ? '' : 's'} in scope`} description="Units are ordered by asset code.">
              <Table caption="Stock units">
                <THead>
                  <TR>
                    <TH>Asset</TH>
                    <TH>Item</TH>
                    <TH>Custody</TH>
                    <TH>State</TH>
                    <TH>Allocation</TH>
                    <TH>Project</TH>
                    <TH>Serial</TH>
                  </TR>
                </THead>
                <TBody>
                  {d.units.length === 0 ? (
                    <EmptyRow cols={7}>No units at this location.</EmptyRow>
                  ) : (
                    d.units.map((u) => (
                      <TR key={u.id} className="cursor-pointer" onClick={() => nav(`/delivery/units/${u.id}`)}>
                        <RowHeader><span className="code">{u.asset_code}</span></RowHeader>
                        <TD className="max-w-[200px] truncate" title={u.item_description}>{u.item_code ?? '—'}</TD>
                        <TD>{u.custody_code ?? '—'}</TD>
                        <TD><StateBadge state={u.state} /></TD>
                        <TD><StateBadge state={u.allocation_status} context="allocation" /></TD>
                        <TD>{u.project_code ?? '—'}</TD>
                        <TD><span className="code">{u.serial_number ?? '—'}</span></TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </Section>
          </div>
        )}
      </QueryView>
    </>
  )
}
