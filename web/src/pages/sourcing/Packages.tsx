import { PackageCheck, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { planning, sourcing } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { RequirementListRow, SourcingPackage } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, cn } from '@/lib/utils'

export function Packages() {
  const s = useSession()
  const c = useAppContext()
  const nav = useNavigate()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [programmeId, setProgrammeId] = useState(c.programmeId ?? '')
  const [currency, setCurrency] = useState('USD')
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  const q = useApi(['sourcing', 'packages'], sourcing.packages)
  const reqs = useApi(['planning', 'requirements', 'approved-lines'], planning.requirements(null), { enabled: open, staleTime: 60_000 })

  const approved = useMemo(() => asList<RequirementListRow>(reqs.data).filter((r) => r.current_revision?.state === 'APPROVED'), [reqs.data])

  const create = useCommand({
    run: () => {
      const lines = approved
        .filter((r) => picked[r.id] && r.current_revision)
        .map((r) => ({
          line_key: r.code,
          requirement_revision_id: r.current_revision!.id,
          quantity: r.current_revision!.quantity,
          uom: r.current_revision!.uom,
          scope_json: { required: [] },
        }))
      return sourcing.createPackage({ code: code.trim(), title: title.trim(), programme_id: programmeId, currency, lines })
    },
    invalidate: [['sourcing']],
    success: (p) => `Package ${p.code} created`,
    onSuccess: (p) => {
      setOpen(false)
      nav(`/sourcing/packages/${p.id}`)
    },
  })

  const rows = asList<SourcingPackage>(q.data)
  const filtered = rows.filter((p) => {
    if (!search.trim()) return true
    const t = search.toLowerCase()
    return p.code.toLowerCase().includes(t) || p.title.toLowerCase().includes(t)
  })

  return (
    <>
      <PageHeader
        eyebrow="Sourcing"
        title="Packages"
        description="Issued bid packages, offer revisions, normalization evidence and the award of record."
        actions={
          s.can('package.manage') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus aria-hidden /> New package
            </Button>
          ) : null
        }
      />

      <Section
        title={`${filtered.length} package${filtered.length === 1 ? '' : 's'}`}
        description="Only approved requirement revisions can be packaged."
        actions={
          <label className="relative">
            <span className="sr-only">Search packages</span>
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or title" className="h-8 w-60 pl-7" />
          </label>
        }
      >
        <QueryView
          q={q}
          rows={5}
          empty={<EmptyState icon={<PackageCheck />} title="No sourcing packages" message="Create a package from approved requirement revisions to start a competitive evaluation." />}
        >
          {() => (
            <Table caption="Sourcing packages">
              <THead>
                <TR>
                  <TH>Package</TH>
                  <TH>State</TH>
                  <TH>Currency</TH>
                  <TH numeric>Lines</TH>
                  <TH numeric>Offers</TH>
                  <TH numeric>Evaluations</TH>
                  <TH>Bid due</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {filtered.length === 0 ? (
                  <EmptyRow cols={8}>No package matches “{search}”.</EmptyRow>
                ) : (
                  filtered.map((p) => (
                    <TR key={p.id} className="cursor-pointer" onClick={() => nav(`/sourcing/packages/${p.id}`)}>
                      <RowHeader>
                        <span className="code">{p.code}</span>
                        <span className="mt-0.5 block max-w-[340px] truncate text-[12px] text-muted-foreground" title={p.title}>{p.title}</span>
                      </RowHeader>
                      <TD><StateBadge state={p.state} /></TD>
                      <TD>{p.currency}</TD>
                      <TD numeric>{p.lines?.length ?? 0}</TD>
                      <TD numeric>{p.offers?.length ?? 0}</TD>
                      <TD numeric>{p.evaluations?.length ?? 0}</TD>
                      <TD><DateTimeText value={p.bid_due_at} /></TD>
                      <TD><DateTimeText value={p.created_at} /></TD>
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
        title="New sourcing package"
        description="Group approved requirements into one competitive bid."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!code.trim() || !title.trim() || !programmeId || !Object.values(picked).some(Boolean)} onClick={() => create.mutate()}>
              Create package
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className={cn('grid gap-3 sm:grid-cols-2')}>
            <Field label="Package code" required>
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="PKG-BKK2-CHILLERS" />
            </Field>
            <Field label="Title" required>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="BKK2 central cooling plant" />
            </Field>
            <Field label="Programme" required>
              <Select value={programmeId} onChange={(e) => setProgrammeId(e.target.value)}>
                <option value="">Select programme</option>
                {c.programmes.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Currency" required>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
            </Field>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Package lines</p>
            <p className="mb-2 text-[11px] text-muted-foreground">Only requirements with an approved revision can be sourced.</p>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {reqs.isPending ? (
                <p className="p-2 text-xs text-muted-foreground">Loading requirements…</p>
              ) : approved.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">No approved requirements. Approve a requirement revision first.</p>
              ) : (
                approved.map((r) => (
                  <div key={r.id} className="rounded px-2 py-1.5 hover:bg-muted">
                    <Checkbox
                      checked={!!picked[r.id]}
                      onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })}
                      label={
                        <span>
                          <span className="code">{r.code}</span>
                          <span className="ml-2 text-[12px]">{r.title}</span>
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            rev {r.current_revision?.revision_no} · {r.current_revision?.quantity} {r.current_revision?.uom}
                          </span>
                        </span>
                      }
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Dialog>
    </>
  )
}
