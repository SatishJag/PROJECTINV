import { RefreshCw, Unplug } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { step1 } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { Step1Run, Step1SyncReport } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { Callout, DateTimeText, ErrorPanel, LoadingBlock, Metric, PageHeader, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, EmptyRow } from '@/components/ui/table'
import { relativeAge } from '@/lib/format'

const count = (run: Step1Run, key: keyof NonNullable<Step1Run['counts_json']>) => run.counts_json?.[key] ?? 0

export function Step1Admin() {
  const s = useSession()
  const toast = useToast()
  const [report, setReport] = useState<Step1SyncReport | null>(null)

  const status = useApi(['step1', 'status'], step1.status)
  const runs = useApi(['step1', 'runs'], step1.runs(20))

  const sync = useCommand({
    run: () => step1.sync(),
    invalidate: [['step1'], ['integrations']],
    onSuccess: (r) => {
      setReport(r)
      const c = r.counts
      const summary = `${c.created} created, ${c.revised} revised, ${c.queued} queued, ${c.exceptions} exceptions`
      if (r.state === 'FAILED') toast.push({ tone: 'danger', title: 'Step 1 sync failed', message: r.error ?? undefined })
      else toast.push({ tone: r.state === 'PARTIAL' ? 'warning' : 'success', title: r.state === 'PARTIAL' ? 'Step 1 sync partly complete' : 'Step 1 sync complete', message: summary })
    },
  })

  const data = status.data
  const last = data?.last_run ?? null
  const failure = report?.state === 'FAILED' ? report.error : last?.state === 'FAILED' ? last.error : null
  const good = data?.last_good_run ?? null
  const goodAge = good ? (relativeAge(good.finished_at ?? good.started_at) ?? 'time not recorded') : null

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Step 1 feed"
        description="Pulls long-lead items from the Step 1 register into PCX requirements. Items not yet classified wait for an estimator or engineer to decide."
        actions={
          s.can('step1.sync') && data?.configured ? (
            <Button variant="primary" loading={sync.isPending} onClick={() => sync.mutate()}>
              <RefreshCw aria-hidden /> Sync now
            </Button>
          ) : null
        }
      />

      {status.isPending ? <LoadingBlock rows={4} label="Loading Step 1 status" /> : null}
      {status.isError ? <ErrorPanel error={status.error} onRetry={() => void status.refetch()} /> : null}

      {data ? (
        <>
          {!data.configured ? (
            <Callout className="mb-4" tone="warning" title="Not configured" icon={<Unplug />}>
              Step 1 is not connected to this server. Set <span className="code">PCX_STEP1_BASE_URL</span> and <span className="code">PCX_STEP1_APP_PASSWORD</span> in the backend environment, then restart it.
            </Callout>
          ) : null}
          {failure ? (
            <Callout className="mb-4" tone="danger" title="Last sync failed">
              <p>{failure}</p>
              <p className="mt-1">{goodAge ? `Last good sync: ${goodAge}` : 'No successful sync yet'}</p>
            </Callout>
          ) : null}

          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Configured" value={data.configured ? 'Yes' : 'No'} tone={data.configured ? 'success' : 'warning'} />
            <Metric
              label="Last run"
              value={last ? <StateBadge state={last.state} /> : <span className="text-base text-muted-foreground">Never run</span>}
              tone={last ? (last.state === 'SUCCEEDED' ? 'success' : last.state === 'PARTIAL' ? 'warning' : 'danger') : 'neutral'}
              hint={last ? (relativeAge(last.started_at) ?? 'Time not recorded') : undefined}
            />
            <Metric label="Pending items" value={data.pending_items} tone={data.pending_items ? 'warning' : 'neutral'} hint="Awaiting a long-lead decision" />
            <Metric label="Open exceptions" value={data.open_exceptions} tone={data.open_exceptions ? 'danger' : 'success'} />
          </div>
        </>
      ) : null}

      <Section title="Run history" description="Newest first. Each run is one transaction; a failed run changes nothing.">
        {runs.isPending ? <LoadingBlock rows={3} label="Loading run history" /> : null}
        {runs.isError ? <ErrorPanel error={runs.error} onRetry={() => void runs.refetch()} compact /> : null}
        {runs.data ? (
          <Table caption="Step 1 sync runs">
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Actor</TH>
                <TH>State</TH>
                <TH numeric>Created</TH>
                <TH numeric>Revised</TH>
                <TH numeric>Unchanged</TH>
                <TH numeric>Queued</TH>
                <TH numeric>Exceptions</TH>
              </TR>
            </THead>
            <TBody>
              {runs.data.length === 0 ? (
                <EmptyRow cols={8}>No Step 1 sync has run yet.</EmptyRow>
              ) : (
                runs.data.map((r) => (
                  <TR key={r.id}>
                    <TD className="whitespace-nowrap"><DateTimeText value={r.started_at} /></TD>
                    <TD>{r.actor}</TD>
                    <TD>
                      <StateBadge state={r.state} />
                      {r.error ? <p className="mt-1 max-w-xs text-xs text-danger">{r.error}</p> : null}
                    </TD>
                    <TD numeric>{count(r, 'created')}</TD>
                    <TD numeric>{count(r, 'revised')}</TD>
                    <TD numeric>{count(r, 'unchanged')}</TD>
                    <TD numeric>{count(r, 'queued')}</TD>
                    <TD numeric>{count(r, 'exceptions')}</TD>
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        ) : null}
      </Section>

      {report && report.projects.length > 0 ? (
        <Section className="mt-4" title="Last sync by project" description="Result of the sync you just ran.">
          <Table caption="Step 1 sync result by project">
            <THead>
              <TR>
                <TH>Step 1 project</TH>
                <TH>PCX project</TH>
                <TH>Status</TH>
                <TH>Reason</TH>
              </TR>
            </THead>
            <TBody>
              {report.projects.map((p) => (
                <TR key={p.step1_project_id}>
                  <TD><span className="code">{p.step1_project_id}</span></TD>
                  <TD>{p.pcx_project_id ? <span className="code">{p.pcx_project_id}</span> : <span className="text-muted-foreground">Not mapped</span>}</TD>
                  <TD><StateBadge state={p.status} /></TD>
                  <TD>{p.reason ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        Conflicts and unmatched items are raised as{' '}
        <Link className="text-accent underline-offset-2 hover:underline" to="/admin/exceptions">exceptions</Link>.
      </p>
    </>
  )
}
