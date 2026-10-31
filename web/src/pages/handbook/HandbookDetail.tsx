import { ArrowLeft, BookOpen, Download, FileWarning, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { handbooks } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { Blocker, HandbookEntry } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { CommandDialog } from '@/components/CommandDialog'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  Callout,
  DateText,
  DateTimeText,
  EmptyState,
  ErrorPanel,
  IdentityBand,
  KV,
  LoadingBlock,
  Mono,
  PageHeader,
  Section,
  StateBadge,
} from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { humanize } from '@/lib/utils'
import { addDays, todayISO } from '@/lib/format'

type Action = 'approve' | 'publish' | 'new-version'

function blockerText(b: Blocker): { title: string; detail: string } {
  if (typeof b === 'string') return { title: b, detail: '' }
  const title = b.title ?? b.criterion_code ?? b.entry_id ?? 'Blocking criterion'
  const detail = b.message ?? b.reason ?? ''
  return { title, detail }
}

export function HandbookDetail() {
  const { packageId = '' } = useParams()
  const s = useSession()
  const q = useApi(['handbooks', 'package', packageId], handbooks.detail(packageId), { enabled: !!packageId })
  const [action, setAction] = useState<Action | null>(null)
  const [waiveEntry, setWaiveEntry] = useState<HandbookEntry | null>(null)
  const [waiveReason, setWaiveReason] = useState('')
  const [waiveUntil, setWaiveUntil] = useState(addDays(todayISO(), 30))
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [decision, setDecision] = useState('ACCEPTED')
  const [notes, setNotes] = useState('')

  const d = q.data
  const blockers = useMemo(() => d?.blockers ?? [], [d])

  const validate = useCommand({
    run: () => handbooks.validate(packageId),
    invalidate: [['handbooks']],
    success: (r) => `Validated — ${r.state === 'READY' ? 'ready for approval' : r.state === 'BLOCKED' ? 'blocked by missing evidence' : humanize(r.state).toLowerCase()}`,
  })

  const waive = useCommand({
    run: () => (waiveEntry ? handbooks.waive(packageId, waiveEntry.id, { reason: waiveReason.trim(), expires_at: waiveUntil }) : Promise.resolve(null)),
    invalidate: [['handbooks']],
    success: 'Criterion waived',
    onSuccess: () => {
      setWaiveEntry(null)
      setWaiveReason('')
    },
  })

  const accept = useCommand({
    run: () => handbooks.acceptance(packageId, { decision, notes: notes.trim() }, { ifMatch: d?.etag }),
    invalidate: [['handbooks']],
    success: 'Acceptance recorded',
    onSuccess: () => {
      setAcceptOpen(false)
      setNotes('')
    },
  })

  const exportPkg = useCommand({
    run: async () => {
      const data = await handbooks.exportPackage(packageId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `handbook-${d?.asset_code ?? packageId}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      return data
    },
    success: 'Recipient handbook exported',
  })

  if (q.isPending) {
    return (
      <>
        <PageHeader eyebrow="Handbook" title="Handbook package" />
        <LoadingBlock rows={8} label="Loading handbook" />
      </>
    )
  }
  if (q.isError) {
    return (
      <>
        <PageHeader eyebrow="Handbook" title="Handbook package" />
        <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
      </>
    )
  }
  if (!d) return null

  const published = d.state === 'PUBLISHED'
  const entries = d.entries ?? []

  return (
    <>
      <PageHeader
        eyebrow={
          <Link className="inline-flex items-center gap-1 hover:underline" to="/handbook/packages">
            <ArrowLeft className="size-3" aria-hidden /> Handbook workbench
          </Link>
        }
        title={<span className="inline-flex flex-wrap items-center gap-2">{d.asset_code ?? 'Asset handbook'} <span className="text-muted-foreground">v{d.version_no}</span> <StateBadge state={d.state} /></span>}
        description={`${d.template?.name ?? 'Class template'} · ${entries.length} criteria · evidence cut-off ${d.evidence_cutoff ? new Date(d.evidence_cutoff).toLocaleString() : 'not set'}`}
        actions={
          <>
            {!published && s.can('handbook.validate') ? <Button onClick={() => validate.mutate()} loading={validate.isPending}>Validate</Button> : null}
            {d.state === 'READY' && s.can('handbook.approve') ? (
              <Button variant="primary" disabled={!d.etag} onClick={() => setAction('approve')}>Approve</Button>
            ) : null}
            {d.state === 'APPROVED' && s.can('handbook.publish') ? (
              <Button variant="primary" disabled={!d.etag} onClick={() => setAction('publish')}>Publish</Button>
            ) : null}
            {published && s.can('handbook.accept') ? (
              <Button variant="primary" onClick={() => setAcceptOpen(true)}>Record acceptance</Button>
            ) : null}
            {published && s.can('handbook.validate') ? (
              <Button onClick={() => setAction('new-version')}>New version</Button>
            ) : null}
            <Button onClick={() => exportPkg.mutate()} loading={exportPkg.isPending}><Download aria-hidden /> Export</Button>
          </>
        }
      />

      <IdentityBand
        items={[
          { label: 'Asset', value: <span className="code">{d.asset_code ?? d.unit_id.slice(0, 8)}</span> },
          { label: 'Template', value: <span className="code">{d.template_code ?? d.template_id.slice(0, 8)}</span> },
          { label: 'Version', value: `v${d.version_no}` },
          { label: 'Acceptance', value: <StateBadge state={d.acceptance_state} /> },
          { label: 'Published', value: <DateTimeText value={d.published_at} /> },
        ]}
        right={<StateBadge state={d.state} />}
      />

      {d.state === 'BLOCKED' ? (
        <Callout className="mb-4" tone="danger" icon={<FileWarning />} title={`${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`}>
          Resolve missing or failing criteria, or waive them with a reason and expiry, then validate again.
        </Callout>
      ) : null}
      {published ? (
        <Callout className="mb-4" tone="success" icon={<ShieldCheck />} title="Published package is immutable">
          The package hash locks the manifest. Acceptance is recorded by FM; revisions start a new version.
        </Callout>
      ) : null}

      <Tabs defaultValue="entries" className="rounded-lg border bg-card px-4 pb-4 pt-2">
        <TabsList>
          <TabsTrigger value="entries"><BookOpen className="size-3.5" aria-hidden /> Entries ({entries.length})</TabsTrigger>
          <TabsTrigger value="blockers">Blockers ({blockers.length})</TabsTrigger>
          <TabsTrigger value="package">Package</TabsTrigger>
        </TabsList>

        <TabsContent value="entries">
          <Table caption="Handbook criteria entries">
            <THead>
              <TR>
                <TH>Criterion</TH>
                <TH>Section</TH>
                <TH>Title</TH>
                <TH>Validation</TH>
                <TH>Message</TH>
                <TH>Owner</TH>
                <TH>Due</TH>
                <TH>Waiver</TH>
                <TH className="text-right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {entries.length === 0 ? (
                <EmptyRow cols={9}>No entries in this package.</EmptyRow>
              ) : (
                entries.map((e) => {
                  const cr = e.criterion
                  return (
                    <TR key={e.id}>
                      <RowHeader><span className="code">{cr?.criterion_code ?? e.criterion_id.slice(0, 6)}</span></RowHeader>
                      <TD>{cr?.section ?? '—'}</TD>
                      <TD>
                        {cr?.title ?? '—'}
                        <span className="ml-1 inline-flex gap-1">
                          {cr?.mandatory ? <Badge tone="warning">Mandatory</Badge> : null}
                          {cr?.critical ? <Badge tone="danger">Critical</Badge> : null}
                        </span>
                      </TD>
                      <TD><StateBadge state={e.validation} /></TD>
                      <TD className="max-w-[22rem] text-xs text-muted-foreground">{e.message ?? '—'}</TD>
                      <TD>{e.owner_role ? humanize(e.owner_role) : '—'}</TD>
                      <TD><DateText value={e.due_date} /></TD>
                      <TD>
                        {e.validation === 'WAIVED' ? (
                          <span className="text-xs" title={e.waiver_reason ?? undefined}>
                            By {e.waiver_by ?? 'unknown'}
                            <span className="block text-[11px] text-muted-foreground">Expires {e.waiver_expires_at ? <DateText value={e.waiver_expires_at} /> : 'never'}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TD>
                      <TD className="text-right">
                        {!published && e.validation !== 'PASS' && e.validation !== 'WAIVED' && s.can('handbook.waive') ? (
                          <Button size="sm" onClick={() => { setWaiveEntry(e); setWaiveReason(''); setWaiveUntil(addDays(todayISO(), 30)) }}>Waive</Button>
                        ) : null}
                      </TD>
                    </TR>
                  )
                })
              )}
            </TBody>
          </Table>
        </TabsContent>

        <TabsContent value="blockers">
          {blockers.length === 0 ? (
            <EmptyState icon={<ShieldCheck />} title="No blockers" message="Every criteria entry is satisfied, waived or not mandatory." />
          ) : (
            <ul className="space-y-2 p-1">
              {blockers.map((b, i) => {
                const t = blockerText(b)
                const critical = typeof b === 'object' && b.critical
                return (
                  <li key={`${t.title}-${i}`} className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="flex items-center gap-2 text-[13px] font-semibold">
                      {critical ? <Badge tone="danger">Critical</Badge> : null}
                      {t.title}
                    </p>
                    {t.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{t.detail}</p> : null}
                  </li>
                )
              })}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="package">
          <div className="space-y-4">
            <KV
              cols={3}
              items={[
                { label: 'Version', value: `v${d.version_no}` },
                { label: 'Template', value: <span className="code">{d.template_code ?? d.template_id.slice(0, 8)}</span> },
                { label: 'Evidence cut-off', value: <DateTimeText value={d.evidence_cutoff} /> },
                { label: 'Approved by', value: d.approved_by ?? '—' },
                { label: 'Published at', value: <DateTimeText value={d.published_at} /> },
                { label: 'Package hash', value: d.package_hash ? <Mono copy>{d.package_hash}</Mono> : 'Not yet published' },
                { label: 'Acceptance', value: <StateBadge state={d.acceptance_state} /> },
                { label: 'Accepted by', value: d.accepted_by ?? '—' },
                { label: 'Acceptance notes', value: d.acceptance_notes ?? '—' },
              ]}
            />
            <Section title="Manifest" description="Structured manifest recorded at publish.">
              <pre className="max-h-72 overflow-auto bg-muted/40 px-4 py-3 text-[11px] leading-relaxed">
                {JSON.stringify(d.manifest_json ?? {}, null, 2)}
              </pre>
            </Section>
          </div>
        </TabsContent>
      </Tabs>

      <CommandDialog
        open={!!action}
        onOpenChange={(o) => !o && setAction(null)}
        title={action === 'approve' ? 'Approve handbook' : action === 'publish' ? 'Publish handbook' : 'Create new version'}
        description={
          action === 'approve'
            ? 'Approval requires a READY package and the current version (If-Match).'
            : action === 'publish'
              ? 'Publishing hashes the manifest and queues the Procore and Planon handover.'
              : 'Clones every criterion into a fresh draft. The published version stays untouched.'
        }
        confirmLabel={action === 'approve' ? 'Approve' : action === 'publish' ? 'Publish' : 'Create version'}
        run={() =>
          action === 'approve'
            ? handbooks.approve(packageId, { ifMatch: d.etag })
            : action === 'publish'
              ? handbooks.publish(packageId, { ifMatch: d.etag })
              : handbooks.newVersion(packageId)
        }
        invalidate={[['handbooks']]}
        success={action === 'approve' ? 'Handbook approved' : action === 'publish' ? 'Handbook published' : 'New draft version created'}
        onDone={() => setAction(null)}
        disabled={!d.etag ? 'This record has no version token; reload before acting.' : undefined}
      >
        <KV
          cols={2}
          items={[
            { label: 'Asset', value: <span className="code">{d.asset_code ?? d.unit_id.slice(0, 8)}</span> },
            { label: 'Version', value: `v${d.version_no}` },
            { label: 'State', value: <StateBadge state={d.state} /> },
            { label: 'Entries', value: entries.length },
          ]}
        />
      </CommandDialog>

      <Dialog
        open={!!waiveEntry}
        onOpenChange={(o) => !o && setWaiveEntry(null)}
        title="Waive criterion"
        description={waiveEntry?.criterion?.title}
        footer={
          <>
            <Button onClick={() => setWaiveEntry(null)}>Cancel</Button>
            <Button variant="primary" loading={waive.isPending} disabled={!waiveReason.trim() || !waiveUntil} onClick={() => waive.mutate()}>Waive</Button>
          </>
        }
      >
        <div className="space-y-3">
          {waiveEntry?.criterion?.critical ? (
            <Callout tone="warning" title="Critical criterion">A critical criterion can only be waived by Engineering.</Callout>
          ) : null}
          <Field label="Reason" required hint="Recorded on the audit trail with your identity.">
            <Textarea value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} placeholder="Why this evidence cannot be supplied before handover." />
          </Field>
          <Field label="Expires at" required hint="Waivers lapse and the package must be revalidated.">
            <Input type="date" min={todayISO()} value={waiveUntil} onChange={(e) => setWaiveUntil(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={acceptOpen}
        onOpenChange={setAcceptOpen}
        title="Record handover acceptance"
        description="FM accepts, accepts conditionally or rejects the published package."
        footer={
          <>
            <Button onClick={() => setAcceptOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={accept.isPending} disabled={decision !== 'ACCEPTED' && !notes.trim()} onClick={() => accept.mutate()}>Record decision</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Decision" required>
            <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="ACCEPTED">Accepted</option>
              <option value="CONDITIONAL">Conditional</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          </Field>
          <Field label="Notes" required={decision !== 'ACCEPTED'} hint="Conditions or rejection reasons are part of the handover record.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <p className="mt-4 text-xs text-muted-foreground">
        The recipient export excludes commercial annexes. Download it from <strong>Export</strong> above or review the{' '}
        <Link className="text-accent underline-offset-2 hover:underline" to={`/delivery/units/${d.unit_id}`}>unit passport</Link>.
      </p>
    </>
  )
}
