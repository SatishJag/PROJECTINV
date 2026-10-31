import { CheckCircle2, GitPullRequestArrow } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { planning } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { ImpactAction } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { CommandDialog } from '@/components/CommandDialog'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/form'
import { EmptyState, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

export function ImpactActions() {
  const s = useSession()
  const [state, setState] = useState('OPEN')
  const [target, setTarget] = useState<{ id: string; reason: string } | null>(null)
  const q = useApi(['planning', 'impact-actions', state || 'all'], planning.impactActions(state || undefined))

  const resolve = useCommand({
    run: (v: { id: string; resolution: string }) => planning.resolveImpact(v.id, v.resolution),
    invalidate: [['planning'], ['dashboard']],
    success: 'Impact action resolved',
    onSuccess: () => setTarget(null),
  })

  return (
    <>
      <PageHeader
        eyebrow="Planning & BOQ"
        title="Impact actions"
        description="Downstream records that must be reviewed after a requirement revision is approved."
        actions={
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            State
            <Select value={state} onChange={(e) => setState(e.target.value)} className="w-40">
              <option value="OPEN">Open</option>
              <option value="RESOLVED">Resolved</option>
              <option value="">All</option>
            </Select>
          </label>
        }
      />

      <Section title={`${asList(q.data).length} action${asList(q.data).length === 1 ? '' : 's'}`} description="Owners receive the action; resolution is recorded for audit.">
        <QueryView
          q={q}
          rows={6}
          empty={<EmptyState icon={<CheckCircle2 />} title="No impact actions" message="Approving a revision that changes an approved basis opens impact actions here." />}
        >
          {() => (
            <Table caption="Impact actions">
              <THead>
                <TR>
                  <TH>Requirement</TH>
                  <TH>Subject</TH>
                  <TH>Reason</TH>
                  <TH>Owner</TH>
                  <TH>State</TH>
                  <TH>Resolution</TH>
                  <TH className="text-right">Action</TH>
                </TR>
              </THead>
              <TBody>
                {asList<ImpactAction>(q.data).length === 0 ? (
                  <EmptyRow cols={7}>No actions in this filter.</EmptyRow>
                ) : (
                  asList<ImpactAction>(q.data).map((a) => (
                    <TR key={a.id}>
                      <RowHeader>
                        <Link className="code text-accent hover:underline" to={`/planning/requirements/${a.requirement_id}`}>
                          {a.requirement_id.slice(0, 8)}
                        </Link>
                      </RowHeader>
                      <TD>
                        <span className="code">{a.subject_type}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">{a.subject_id.slice(0, 8)}</span>
                      </TD>
                      <TD className="max-w-[360px]">{a.reason}</TD>
                      <TD>{humanize(a.owner_role)}</TD>
                      <TD><StateBadge state={a.state} /></TD>
                      <TD className="max-w-[220px] text-xs">{a.resolution ?? '—'}</TD>
                      <TD className="text-right">
                        {a.state === 'OPEN' && s.can('requirement.edit') ? (
                          <Button size="sm" onClick={() => setTarget({ id: a.id, reason: a.reason })}>
                            <GitPullRequestArrow aria-hidden /> Resolve
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <CommandDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Resolve impact action"
        description="Describe what was reviewed or changed downstream."
        confirmLabel="Resolve"
        reason={{ label: 'Resolution', required: true, placeholder: 'Handbook re-validated against revision 2; no change required.' }}
        run={(resolution) => (target ? resolve.mutateAsync({ id: target.id, resolution }) : Promise.resolve(undefined))}
        invalidate={[['planning'], ['dashboard']]}
        success="Impact action resolved"
      >
        <p className="text-[13px] text-muted-foreground">{target?.reason}</p>
      </CommandDialog>
    </>
  )
}
