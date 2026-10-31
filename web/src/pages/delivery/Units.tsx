import { Boxes, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { assets } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { PhysicalUnit } from '@/api/types'
import { useAppContext } from '@/context/AppContext'
import { Input, Select } from '@/components/ui/form'
import { EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList } from '@/lib/utils'

const STATES = ['', 'PLANNED', 'IN_TRANSIT', 'RECEIVED', 'ISSUED', 'INSTALLED', 'IN_REPAIR', 'RETURNED', 'SCRAPPED', 'CANCELLED', 'RETIRED']
const ALLOCATIONS = ['', 'UNALLOCATED', 'ALLOCATED', 'RESERVED', 'ISSUED']

export function Units() {
  const c = useAppContext()
  const nav = useNavigate()
  const [state, setState] = useState('')
  const [allocation, setAllocation] = useState('')
  const [project, setProject] = useState(c.projectId ?? '')
  const [search, setSearch] = useState('')

  const units = useApi(['delivery', 'units', c.programmeId ?? 'all', state, allocation, project, search], assets.units({ programme_id: c.programmeId ?? null, state: state || undefined, allocation_status: allocation || undefined, project_id: project || null, q: search || undefined }),
  )

  const rows = useMemo(() => asList<PhysicalUnit>(units.data), [units.data])
  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const u of rows) m[u.state] = (m[u.state] ?? 0) + 1
    return m
  }, [rows])

  return (
    <>
      <PageHeader
        eyebrow="Delivery"
        title="Equipment units"
        description="Serialized asset passports with custody, condition, tests and integration links."
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {['RECEIVED', 'PLANNED', 'IN_TRANSIT', 'ISSUED', 'INSTALLED', 'IN_REPAIR'].map((st) => (
          <button
            key={st}
            type="button"
            onClick={() => setState((cur) => (cur === st ? '' : st))}
            className={`rounded-lg border bg-card px-3 py-2 text-left transition hover:border-accent ${state === st ? 'border-accent ring-1 ring-accent' : ''}`}
          >
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{st.replace('_', ' ')}</span>
            <span className="mt-0.5 block text-lg font-semibold tabular-nums">{counts[st] ?? 0}</span>
          </button>
        ))}
      </div>

      <Section
        title={`${rows.length} unit${rows.length === 1 ? '' : 's'}`}
        description="Component units are shown under their parent passport."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search units</span>
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input className="h-8 w-52 pl-7" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Asset, serial, position" />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              State
              <Select value={state} onChange={(e) => setState(e.target.value)} className="w-32">
                {STATES.map((x) => <option key={x} value={x}>{x ? x.replace('_', ' ') : 'All'}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Allocation
              <Select value={allocation} onChange={(e) => setAllocation(e.target.value)} className="w-36">
                {ALLOCATIONS.map((x) => <option key={x} value={x}>{x || 'All'}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Project
              <Select value={project} onChange={(e) => setProject(e.target.value)} className="w-36">
                <option value="">All</option>
                {c.projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
              </Select>
            </label>
          </div>
        }
      >
        <QueryView q={units} rows={7} empty={<EmptyState icon={<Boxes />} title="No units in this scope" message="Import a purchase order acknowledgement or receive a shipment to create serialized units." />}>
          {() => (
            <Table caption="Equipment units">
              <THead>
                <TR>
                  <TH>Asset</TH>
                  <TH>Item</TH>
                  <TH>Serial</TH>
                  <TH>State</TH>
                  <TH>Allocation</TH>
                  <TH>Custody</TH>
                  <TH>Project</TH>
                  <TH>Position</TH>
                  <TH>Condition</TH>
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={9}>No units match these filters.</EmptyRow>
                ) : (
                  rows.map((u) => (
                    <TR key={u.id} className="cursor-pointer" onClick={() => nav(`/delivery/units/${u.id}`)}>
                      <RowHeader><span className="code">{u.asset_code}</span></RowHeader>
                      <TD className="max-w-[220px] truncate" title={u.item_description}>{u.item_code ?? '—'}</TD>
                      <TD><span className="code">{u.serial_number ?? '—'}</span></TD>
                      <TD><StateBadge state={u.state} /></TD>
                      <TD><StateBadge state={u.allocation_status} context="allocation" /></TD>
                      <TD>{u.custody_code ?? '—'}</TD>
                      <TD>{u.project_code ?? '—'}</TD>
                      <TD className="max-w-[160px] truncate">{u.installed_position ?? '—'}</TD>
                      <TD><StateBadge state={u.condition} /></TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>
    </>
  )
}

