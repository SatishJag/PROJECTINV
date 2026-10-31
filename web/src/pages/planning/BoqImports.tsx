import { FileSpreadsheet, Plus } from 'lucide-react'
import { useState } from 'react'
import { planning } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { BoqRevision } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { DateTimeText, EmptyState, Money, Mono, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList } from '@/lib/utils'

const SAMPLE = JSON.stringify(
  [
    {
      source_line_key: 'BOQ-001',
      equipment_class_code: 'CHILLER',
      title: 'Chiller, 1200 kW',
      quantity: '2',
      uom: 'EA',
      duty: 'continuous',
      capacity: '1200',
      capacity_unit: 'kW',
      budget_amount: '480000',
      currency: 'USD',
      required_site_date: '2027-03-01',
    },
  ],
  null,
  2,
)

export function BoqImports() {
  const s = useSession()
  const c = useAppContext()
  const [scope, setScope] = useState(c.projectId ?? '')
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState(c.projectId ?? c.projects[0]?.id ?? '')
  const [sourceKey, setSourceKey] = useState('')
  const [json, setJson] = useState(SAMPLE)
  const [parseError, setParseError] = useState<string | null>(null)

  const q = useApi(['planning', 'boq', scope || 'all'], planning.boqRevisions(scope || null))
  const rows = asList<BoqRevision>(q.data)

  const imp = useCommand({
    run: (lines: Record<string, unknown>[]) => planning.boqImport({ project_id: project, source_key: sourceKey.trim(), lines }),
    invalidate: [['planning']],
    success: 'BOQ revision imported',
    onSuccess: () => {
      setOpen(false)
      setSourceKey('')
    },
  })

  function submit() {
    setParseError(null)
    try {
      const parsed = JSON.parse(json) as unknown
      if (!Array.isArray(parsed)) {
        setParseError('The document must be a JSON array of lines.')
        return
      }
      imp.mutate(parsed as Record<string, unknown>[])
    } catch {
      setParseError('This is not valid JSON.')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Planning & BOQ"
        title="BOQ imports"
        description="Bill-of-quantities revisions create or update requirement drafts with traced source line keys."
        actions={
          s.can('requirement.edit') ? (
            <Button variant="primary" disabled={!c.projects.length} onClick={() => setOpen(true)}>
              <Plus aria-hidden /> Import revision
            </Button>
          ) : null
        }
      />

      <Section
        title={`${rows.length} BOQ revision${rows.length === 1 ? '' : 's'}`}
        description="Source hash and line links are retained for reconciliation."
        actions={
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            Project
            <Select value={scope} onChange={(e) => setScope(e.target.value)} className="w-44">
              <option value="">All projects</option>
              {c.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code}</option>
              ))}
            </Select>
          </label>
        }
      >
        <QueryView
          q={q}
          rows={5}
          empty={
            <EmptyState
              icon={<FileSpreadsheet />}
              title="No BOQ revision imported"
              message="Import a BOQ to generate requirement drafts with stable source line keys."
              action={s.can('requirement.edit') ? <Button onClick={() => setOpen(true)}>Import revision</Button> : undefined}
            />
          }
        >
          {(list) => (
            <Table caption="BOQ revisions">
              <THead>
                <TR>
                  <TH>Source</TH>
                  <TH>Project</TH>
                  <TH>Revision</TH>
                  <TH>State</TH>
                  <TH numeric>Lines</TH>
                  <TH>Source hash</TH>
                  <TH>Imported</TH>
                </TR>
              </THead>
              <TBody>
                {list.length === 0 ? (
                  <EmptyRow cols={7}>No revisions in this scope.</EmptyRow>
                ) : (
                  list.map((b) => (
                    <TR key={b.id}>
                      <RowHeader><Mono>{b.source_key}</Mono></RowHeader>
                      <TD>{b.project_code ?? '—'}</TD>
                      <TD>Rev {b.revision_no}</TD>
                      <TD><StateBadge state={b.state} /></TD>
                      <TD numeric>{(b.lines as unknown[] | undefined)?.length ?? 0}</TD>
                      <TD><Mono className="text-[11px]">{b.source_hash}</Mono></TD>
                      <TD><DateTimeText value={b.created_at} /></TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      {rows.length ? (
        <Section className="mt-4" title="Imported lines" description="Every imported line is linked to a requirement revision.">
          <div className="space-y-4 p-4">
            {rows.slice(0, 3).map((b) => {
              const lines = (b.lines ?? []) as { id: string; source_line_key: string; requirement_revision_id: string; quantity: string; uom: string; budget_amount: string | null; currency: string }[]
              return (
                <div key={b.id}>
                  <p className="mb-1.5 text-xs font-semibold">
                    {b.source_key} · rev {b.revision_no} · {b.project_code ?? '—'}
                  </p>
                  <Table caption={`Lines for ${b.source_key}`}>
                    <THead>
                      <TR>
                        <TH>Line key</TH>
                        <TH>Requirement revision</TH>
                        <TH numeric>Quantity</TH>
                        <TH numeric>Budget</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {lines.map((l) => (
                        <TR key={l.id}>
                          <RowHeader><Mono>{l.source_line_key}</Mono></RowHeader>
                          <TD><Mono>{l.requirement_revision_id}</Mono></TD>
                          <TD numeric>{l.quantity} {l.uom}</TD>
                          <TD numeric><Money value={l.budget_amount} currency={l.currency} /></TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )
            })}
          </div>
        </Section>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Import BOQ revision"
        description="Paste the extracted BOQ lines. Each source line key is idempotent across revisions."
        size="lg"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={imp.isPending} disabled={!project || !sourceKey.trim()} onClick={submit}>
              Import
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project" required>
              <Select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Select project</option>
                {c.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Source key" required hint="For example BKK2-BOQ-2026-04">
              <Input value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} />
            </Field>
          </div>
          <Field label="Lines (JSON array)" required error={parseError} hint="Keys: source_line_key, equipment_class_code, quantity, uom, title, duty, capacity, capacity_unit, cost_code, budget_amount, currency, required_site_date.">
            <Textarea className="min-h-[260px] font-mono text-[11px]" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </>
  )
}
