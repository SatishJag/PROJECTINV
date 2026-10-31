import { ClipboardList, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { planning, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form'
import { EmptyState, PageHeader, QueryView, StateBadge, DateText, Qty, Money, Section } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, cn } from '@/lib/utils'

interface Draft {
  title: string
  project_id: string
  equipment_class_id: string
  quantity: string
  uom: string
  duty: string
  capacity: string
  capacity_unit: string
  redundancy: string
  required_site_date: string
  required_install_date: string
  cost_code: string
  budget_amount: string
  currency: string
}

const EMPTY: Draft = {
  title: '',
  project_id: '',
  equipment_class_id: '',
  quantity: '1',
  uom: 'EA',
  duty: '',
  capacity: '',
  capacity_unit: 'kW',
  redundancy: '',
  required_site_date: '',
  required_install_date: '',
  cost_code: '',
  budget_amount: '',
  currency: 'USD',
}

export function Requirements() {
  const s = useSession()
  const c = useAppContext()
  const nav = useNavigate()
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<string>(c.projectId ?? '')
  const [open, setOpen] = useState(false)
  const [d, setD] = useState<Draft>(EMPTY)

  const q = useApi(['planning', 'requirements', scope || 'all'], planning.requirements(scope || null))
  const classes = useApi(['ref', 'equipment-classes'], reference.equipmentClasses(), { staleTime: 10 * 60_000 })
  const projects = c.projects

  const create = useCommand({
    run: () =>
      planning.createRequirement({
        title: d.title.trim(),
        project_id: d.project_id || projects[0]?.id || '',
        equipment_class_id: d.equipment_class_id,
        revision: {
          quantity: d.quantity,
          uom: d.uom || 'EA',
          duty: d.duty || null,
          capacity: d.capacity || null,
          capacity_unit: d.capacity_unit || null,
          redundancy: d.redundancy || null,
          required_site_date: d.required_site_date || null,
          required_install_date: d.required_install_date || null,
          cost_code: d.cost_code || null,
          budget_amount: d.budget_amount || null,
          currency: d.currency || 'USD',
        },
      }),
    invalidate: [['planning']],
    success: (r) => `Requirement ${r.requirement.code} created`,
    onSuccess: (r) => {
      setOpen(false)
      setD(EMPTY)
      nav(`/planning/requirements/${r.requirement.id}`)
    },
  })

  const rows = useMemo(() => asList<NonNullable<typeof q.data>[number]>(q.data), [q.data])
  const filtered = rows.filter((r) => {
    if (!search.trim()) return true
    const term = search.toLowerCase()
    return [r.code, r.title, r.project_code, r.equipment_class_name, r.equipment_class_code].some((v) => (v ?? '').toLowerCase().includes(term))
  })

  function openCreate() {
    setD({ ...EMPTY, project_id: c.projectId ?? projects.find((p) => p.status === 'ACTIVE')?.id ?? projects[0]?.id ?? '', equipment_class_id: classes.data?.[0]?.id ?? '' })
    setOpen(true)
  }

  return (
    <>
      <PageHeader
        eyebrow="Planning & BOQ"
        title="Requirements"
        description="Engineering needs with revision history, sourcing route and approved technical basis."
        actions={
          s.can('requirement.edit') ? (
            <Button variant="primary" onClick={openCreate} disabled={!projects.length}>
              <Plus aria-hidden /> New requirement
            </Button>
          ) : null
        }
      />

      <Section
        title={`${filtered.length} requirement${filtered.length === 1 ? '' : 's'}`}
        description={scope ? 'Filtered to the selected data centre.' : 'All data centres in the programme.'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search requirements</span>
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or title" className="h-8 w-56 pl-7" />
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              Project
              <Select value={scope} onChange={(e) => setScope(e.target.value)} className="w-44">
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        }
      >
        <QueryView
          q={q}
          rows={6}
          empty={
            <EmptyState
              icon={<ClipboardList />}
              title="No requirements in this scope"
              message="Create a requirement, or import a BOQ revision to generate requirement drafts."
              action={s.can('requirement.edit') ? <Button onClick={openCreate}>New requirement</Button> : undefined}
            />
          }
        >
          {() => (
            <Table caption="Requirements">
              <THead>
                <TR>
                  <TH>Requirement</TH>
                  <TH>Project</TH>
                  <TH>Equipment class</TH>
                  <TH numeric>Quantity</TH>
                  <TH>Basis</TH>
                  <TH>Required on site</TH>
                  <TH>Route</TH>
                  <TH>State</TH>
                  <TH numeric>Budget</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.length === 0 ? (
                  <EmptyRow cols={9}>No rows match “{search}”.</EmptyRow>
                ) : (
                  filtered.map((r) => {
                    const rev = r.current_revision
                    const basis = [rev?.duty, rev?.capacity && `${rev.capacity} ${rev.capacity_unit ?? ''}`, rev?.redundancy].filter(Boolean).join(' · ')
                    return (
                      <TR key={r.id} className="cursor-pointer" onClick={() => nav(`/planning/requirements/${r.id}`)}>
                        <RowHeader>
                          <span className="code">{r.code}</span>
                          <span className="mt-0.5 block max-w-[320px] truncate text-[12px] text-muted-foreground" title={r.title}>
                            {r.title}
                          </span>
                        </RowHeader>
                        <TD className="whitespace-nowrap">{r.project_code ?? '—'}</TD>
                        <TD className="whitespace-nowrap">{r.equipment_class_name ?? r.equipment_class_code ?? '—'}</TD>
                        <TD numeric>{rev ? <Qty value={rev.quantity} uom={rev.uom} /> : '—'}</TD>
                        <TD className="max-w-[220px] truncate" title={basis}>{basis || <span className="text-muted-foreground">—</span>}</TD>
                        <TD className="whitespace-nowrap"><DateText value={rev?.required_site_date} /></TD>
                        <TD><StateBadge state={r.sourcing_route} /></TD>
                        <TD><StateBadge state={r.state} /></TD>
                        <TD numeric>
                          {rev ? <Money value={rev.budget_amount} currency={rev.currency} commercial /> : <span className="text-muted-foreground">—</span>}
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
        open={open}
        onOpenChange={setOpen}
        title="New requirement"
        description="Creates revision 1 in draft. Submit and approve it before sourcing."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!d.title.trim() || !d.project_id || !d.equipment_class_id || !d.quantity}
              onClick={() => create.mutate()}
            >
              Create draft
            </Button>
          </>
        }
      >
        <div className={cn('grid gap-3', 'sm:grid-cols-2')}>
          <Field label="Title" required className="sm:col-span-2">
            <Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="BKK2 central cooling, 1800 kW" />
          </Field>
          <Field label="Data centre / project" required>
            <Select value={d.project_id} onChange={(e) => setD({ ...d, project_id: e.target.value })}>
              <option value="">Select project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Equipment class" required>
            <Select value={d.equipment_class_id} onChange={(e) => setD({ ...d, equipment_class_id: e.target.value })}>
              <option value="">Select class</option>
              {(classes.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.code} · {k.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quantity" required>
            <Input inputMode="decimal" value={d.quantity} onChange={(e) => setD({ ...d, quantity: e.target.value })} />
          </Field>
          <Field label="Unit of measure">
            <Input value={d.uom} onChange={(e) => setD({ ...d, uom: e.target.value })} />
          </Field>
          <Field label="Duty">
            <Input value={d.duty} onChange={(e) => setD({ ...d, duty: e.target.value })} placeholder="Standby, prime, continuous" />
          </Field>
          <Field label="Capacity">
            <div className="flex gap-1.5">
              <Input inputMode="decimal" value={d.capacity} onChange={(e) => setD({ ...d, capacity: e.target.value })} />
              <Input className="w-20" value={d.capacity_unit} onChange={(e) => setD({ ...d, capacity_unit: e.target.value })} aria-label="Capacity unit" />
            </div>
          </Field>
          <Field label="Redundancy">
            <Input value={d.redundancy} onChange={(e) => setD({ ...d, redundancy: e.target.value })} placeholder="N+1" />
          </Field>
          <Field label="Cost code">
            <Input value={d.cost_code} onChange={(e) => setD({ ...d, cost_code: e.target.value })} />
          </Field>
          <Field label="Required on site">
            <Input type="date" value={d.required_site_date} onChange={(e) => setD({ ...d, required_site_date: e.target.value })} />
          </Field>
          <Field label="Required installation">
            <Input type="date" value={d.required_install_date} onChange={(e) => setD({ ...d, required_install_date: e.target.value })} />
          </Field>
          <Field label="Budget amount">
            <Input inputMode="decimal" value={d.budget_amount} onChange={(e) => setD({ ...d, budget_amount: e.target.value })} />
          </Field>
          <Field label="Currency">
            <Input value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })} maxLength={3} />
          </Field>
        </div>
      </Dialog>
    </>
  )
}
