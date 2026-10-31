import { BookCheck, CheckCircle2, FileText, Plus, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { assets, handbooks } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { EvidenceDocument, HandbookPackage, HandbookTemplate, PhysicalUnit } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Select } from '@/components/ui/form'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Callout, DateText, DateTimeText, EmptyState, Metric, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const STATES = ['DRAFT', 'VALIDATING', 'READY', 'BLOCKED', 'APPROVED', 'PUBLISHED'] as const

export function HandbookWorkbench() {
  const s = useSession()
  const c = useAppContext()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const state = params.get('state') ?? ''
  const setState = (value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set('state', value)
    else next.delete('state')
    setParams(next, { replace: true })
  }
  const [open, setOpen] = useState(false)
  const [unitId, setUnitId] = useState('')
  const [templateId, setTemplateId] = useState('')

  const q = useApi(['handbooks', 'packages', state || 'ALL'], handbooks.list({ state: state || undefined }))
  const templates = useApi(['handbooks', 'templates'], handbooks.templates, { staleTime: 5 * 60_000 })
  const evidence = useApi(['handbooks', 'evidence'], handbooks.evidence())
  const units = useApi(['delivery', 'units', 'handbook'], assets.units({ programme_id: c.programmeId ?? null, include_components: true }), { staleTime: 60_000 })

  const packages = asList<HandbookPackage>(q.data)
  const templateList = asList<HandbookTemplate>(templates.data)
  const evidenceList = asList<EvidenceDocument>(evidence.data)
  const unitMap = useMemo(() => new Map(asList<PhysicalUnit>(units.data).map((u) => [u.id, u])), [units.data])

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of packages) m[p.state] = (m[p.state] ?? 0) + 1
    return m
  }, [packages])

  const create = useCommand({
    run: () => handbooks.create({ unit_id: unitId, template_id: templateId || null }),
    invalidate: [['handbooks']],
    success: (p) => `Handbook v${p.version_no} created`,
    onSuccess: (p) => {
      setOpen(false)
      setUnitId('')
      setTemplateId('')
      navigate(`/handbook/packages/${p.id}`)
    },
  })

  const approve = useCommand({
    run: (id: string) => handbooks.approveEvidence(id),
    invalidate: [['handbooks', 'evidence']],
    success: 'Evidence approved',
  })

  return (
    <>
      <PageHeader
        eyebrow="Handbook & operations"
        title="Handbook workbench"
        description="Assemble the evidence package per asset, validate against the class template, waive with a reason, then approve and publish the immutable hash."
        actions={
          s.can('handbook.validate') ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus aria-hidden /> New handbook
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Packages" value={packages.length} />
        <Metric label="Blocked" value={counts.BLOCKED ?? 0} tone={counts.BLOCKED ? 'danger' : 'success'} hint="Mandatory criteria missing or failing" />
        <Metric label="Ready to approve" value={counts.READY ?? 0} tone="warning" />
        <Metric label="Published" value={counts.PUBLISHED ?? 0} tone="success" />
      </div>

      <Tabs defaultValue="packages" className="rounded-lg border bg-card px-4 pb-4 pt-2">
        <TabsList>
          <TabsTrigger value="packages"><BookCheck className="size-3.5" aria-hidden /> Packages</TabsTrigger>
          <TabsTrigger value="templates"><ShieldCheck className="size-3.5" aria-hidden /> Class templates</TabsTrigger>
          <TabsTrigger value="evidence"><FileText className="size-3.5" aria-hidden /> Evidence library</TabsTrigger>
        </TabsList>

        <TabsContent value="packages">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Published packages are immutable; create a new version to revise them.</p>
            <Select className="w-48" value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
              <option value="">All states</option>
              {STATES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
            </Select>
          </div>
          <QueryView
            q={q}
            rows={6}
            empty={<EmptyState icon={<BookCheck />} title="No handbook packages" message="Create a package for an asset to start collecting its handover evidence." />}
          >
            {() => (
              <Table caption="Handbook packages">
                <THead>
                  <TR>
                    <TH>Asset</TH>
                    <TH>Template</TH>
                    <TH numeric>Version</TH>
                    <TH>State</TH>
                    <TH>Acceptance</TH>
                    <TH>Published</TH>
                    <TH>Package hash</TH>
                    <TH className="text-right">Open</TH>
                  </TR>
                </THead>
                <TBody>
                  {packages.length === 0 ? (
                    <EmptyRow cols={8}>No handbook packages for this filter.</EmptyRow>
                  ) : (
                    packages.map((p) => (
                      <TR key={p.id}>
                        <RowHeader>
                          <Link className="code text-accent underline-offset-2 hover:underline" to={`/handbook/packages/${p.id}`}>
                            {p.asset_code ?? unitMap.get(p.unit_id)?.asset_code ?? p.unit_id.slice(0, 8)}
                          </Link>
                        </RowHeader>
                        <TD><span className="code">{p.template_code ?? p.template_id.slice(0, 8)}</span></TD>
                        <TD numeric>{p.version_no}</TD>
                        <TD><StateBadge state={p.state} /></TD>
                        <TD><StateBadge state={p.acceptance_state} /></TD>
                        <TD><DateTimeText value={p.published_at} /></TD>
                        <TD><span className="code text-[10px]">{p.package_hash ? `${p.package_hash.slice(0, 16)}…` : 'Not hashed'}</span></TD>
                        <TD className="text-right">
                          <Link className="text-xs font-medium text-accent underline-offset-2 hover:underline" to={`/handbook/packages/${p.id}`}>Review</Link>
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            )}
          </QueryView>
        </TabsContent>

        <TabsContent value="templates">
          <QueryView
            q={templates}
            rows={5}
            empty={<EmptyState icon={<ShieldCheck />} title="No templates" message="Class templates are seeded with the equipment class reference data." />}
          >
            {() => (
              <div className="space-y-3">
                {templateList.map((t) => (
                  <Section key={t.id} title={<span>{t.name} <span className="code text-xs text-muted-foreground">{t.template_code} rev {t.revision_no}</span></span>} description={`Recipient: ${humanize(t.recipient_role)} · ${t.criteria?.length ?? 0} criteria · ${humanize(t.state)}`}>
                    <Table caption={`Criteria for ${t.template_code}`}>
                      <THead>
                        <TR>
                          <TH>Code</TH>
                          <TH>Section</TH>
                          <TH>Criterion</TH>
                          <TH>Kind</TH>
                          <TH>Mandatory</TH>
                          <TH>Critical</TH>
                          <TH>Responsible</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {(t.criteria ?? []).length === 0 ? (
                          <EmptyRow cols={7}>No criteria in this template.</EmptyRow>
                        ) : (
                          (t.criteria ?? []).map((cr) => (
                            <TR key={cr.id}>
                              <RowHeader><span className="code">{cr.criterion_code}</span></RowHeader>
                              <TD>{cr.section}</TD>
                              <TD>{cr.title}</TD>
                              <TD>{humanize(cr.kind)}</TD>
                              <TD>{cr.mandatory ? <Badge tone="warning">Mandatory</Badge> : <span className="text-muted-foreground">No</span>}</TD>
                              <TD>{cr.critical ? <Badge tone="danger">Critical</Badge> : <span className="text-muted-foreground">No</span>}</TD>
                              <TD>{humanize(cr.responsible_role)}</TD>
                            </TR>
                          ))
                        )}
                      </TBody>
                    </Table>
                  </Section>
                ))}
              </div>
            )}
          </QueryView>
        </TabsContent>

        <TabsContent value="evidence">
          <QueryView
            q={evidence}
            rows={6}
            empty={<EmptyState icon={<FileText />} title="No evidence documents" message="Evidence appears here when supplier documents are received against an asset." />}
          >
            {() => (
              <Table caption="Evidence documents">
                <THead>
                  <TR>
                    <TH>Asset</TH>
                    <TH>Document</TH>
                    <TH>Type</TH>
                    <TH>Revision</TH>
                    <TH>Approved</TH>
                    <TH>Expires</TH>
                    <TH>Content hash</TH>
                    <TH className="text-right">Action</TH>
                  </TR>
                </THead>
                <TBody>
                  {evidenceList.length === 0 ? (
                    <EmptyRow cols={8}>No evidence documents.</EmptyRow>
                  ) : (
                    evidenceList.map((ev) => (
                      <TR key={ev.id}>
                        <RowHeader><span className="code">{unitMap.get(ev.unit_id)?.asset_code ?? ev.unit_id.slice(0, 8)}</span></RowHeader>
                        <TD>{ev.title}</TD>
                        <TD>{humanize(ev.doc_type)}</TD>
                        <TD>{ev.revision}</TD>
                        <TD>
                          {ev.approved
                            ? <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="size-3.5" aria-hidden /> {ev.approved_by ?? 'Approved'}</span>
                            : <Badge tone="warning">Pending</Badge>}
                        </TD>
                        <TD><DateText value={ev.expires_at} /></TD>
                        <TD><span className="code text-[10px]">{ev.content_hash.slice(0, 16)}…</span></TD>
                        <TD className="text-right">
                          {!ev.approved && s.can('evidence.approve') ? (
                            <Button size="sm" loading={approve.isPending && approve.variables === ev.id} onClick={() => approve.mutate(ev.id)}>Approve</Button>
                          ) : null}
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            )}
          </QueryView>
          <Callout className="mt-3" tone="info" title="Evidence is validated by rule, not by attachment">
            A handbook criterion passes only when the referenced document is present and approved for the serial, model or unit. Commercial evidence is never included in the recipient export.
          </Callout>
        </TabsContent>
      </Tabs>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New handbook package"
        description="Pick the asset and its class template. Entries are created for every criterion; validation fills them from the evidence library and structure."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!unitId} onClick={() => create.mutate()}>
              Create draft
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Asset" required>
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Select unit</option>
              {asList<PhysicalUnit>(units.data).map((u) => (
                <option key={u.id} value={u.id}>{u.asset_code} · {u.item_code ?? 'unknown model'}</option>
              ))}
            </Select>
          </Field>
          <Field label="Template" hint="Leave blank to use the class template for the asset's model.">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Auto-select by class</option>
              {templateList.map((t) => <option key={t.id} value={t.id}>{t.template_code} · {t.name} (rev {t.revision_no})</option>)}
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  )
}
