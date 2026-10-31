import { Link2, Plug, RefreshCw, Unplug } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { integrations, reference } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { ProcoreStatus } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { useAppContext } from '@/context/AppContext'
import { CommandDialog } from '@/components/CommandDialog'
import { JsonView } from '@/components/JsonView'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Checkbox, Field, Input } from '@/components/ui/form'
import { Callout, DateTimeText, EmptyState, ErrorPanel, IdentityBand, KV, LoadingBlock, Metric, PageHeader, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { humanize } from '@/lib/utils'

export function ProcoreAdmin() {
  const s = useSession()
  const c = useAppContext()
  const [connectOpen, setConnectOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [companyId, setCompanyId] = useState('')
  const [authMode, setAuthMode] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [showAuth, setShowAuth] = useState(false)

  const q = useApi(['integrations', 'status'], integrations.procoreStatus)
  const manifest = useApi(['integrations', 'manifest'], integrations.appManifest, { staleTime: 10 * 60_000 })
  const auth = useApi(['integrations', 'authorize'], integrations.authorizeUrl, { enabled: showAuth })
  const health = useApi(['health'], reference.health, { staleTime: 60_000 })
  const status: ProcoreStatus | undefined = q.data

  const connect = useCommand({
    run: () =>
      integrations.connect({
        company_id: companyId.trim() || undefined,
        auth_mode: authMode || undefined,
      }),
    invalidate: [['integrations']],
    success: 'Procore connected',
    onSuccess: () => {
      setConnectOpen(false)
      setCompanyId('')
    },
  })
  const sync = useCommand({
    run: () => integrations.sync(Object.entries(picked).filter(([, v]) => v).map(([k]) => k)),
    invalidate: [['integrations'], ['ref']],
    success: (r) => `Sync complete — ${JSON.stringify(r).length > 120 ? 'review counts below' : 'resources updated'}`,
    onSuccess: () => setSyncOpen(false),
  })

  const resources = status?.resources ?? ['projects', 'vendors', 'cost_codes', 'commitments']
  const openSync = () => {
    const initial: Record<string, boolean> = {}
    for (const r of resources) initial[r] = true
    setPicked(initial)
    setSyncOpen(true)
  }
  const openConnect = () => {
    setCompanyId(status?.connection?.company_id ?? '')
    setAuthMode(status?.mode === 'SIMULATED' ? 'SIMULATED' : 'CLIENT_CREDENTIALS')
    setConnectOpen(true)
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Procore connection"
        description="Embedded app connection, OAuth state, webhook destination and write-back. Writes are queued in the outbox and reconciled, never silently retried."
        actions={
          s.can('integration.manage') ? (
            <>
              {status?.connected ? (
                <>
                  <Button onClick={openSync}><RefreshCw aria-hidden /> Sync</Button>
                  <Button variant="danger" onClick={() => setDisconnectOpen(true)}><Unplug aria-hidden /> Disconnect</Button>
                </>
              ) : (
                <Button variant="primary" onClick={openConnect}><Plug aria-hidden /> Connect</Button>
              )}
            </>
          ) : null
        }
      />

      {q.isPending ? <LoadingBlock rows={6} label="Loading Procore status" /> : null}
      {q.isError ? <ErrorPanel error={q.error} onRetry={() => void q.refetch()} /> : null}

      {status ? (
        <>
          <IdentityBand
            items={[
              { label: 'Mode', value: humanize(status.mode) },
              { label: 'Environment', value: status.environment },
              { label: 'Company', value: status.connection?.company_name ?? status.connection?.company_id ?? 'Not connected' },
              { label: 'Write-back', value: status.writeback_enabled ? 'Enabled' : 'Disabled' },
              { label: 'Last sync', value: <DateTimeText value={status.connection?.last_sync_at} /> },
            ]}
            right={<StateBadge state={status.connected ? 'CONNECTED' : (status.connection?.state ?? 'DISCONNECTED')} />}
          />

          {status.environment_mismatch ? (
            <Callout className="mb-4" tone="danger" title="Environment mismatch">
              The stored connection was created in a different environment than the current mode. Reconnect before syncing.
            </Callout>
          ) : null}
          {status.connection?.last_error ? (
            <Callout className="mb-4" tone="warning" title="Last connection error">{status.connection.last_error}</Callout>
          ) : null}

          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Open exceptions" value={status.open_exceptions ?? 0} tone={status.open_exceptions ? 'danger' : 'success'} />
            <Metric label="Outbox pending" value={status.outbox?.PENDING ?? 0} tone={status.outbox?.PENDING ? 'warning' : 'neutral'} />
            <Metric label="Outbox unconfirmed" value={status.outbox?.UNKNOWN ?? 0} tone={status.outbox?.UNKNOWN ? 'danger' : 'neutral'} />
            <Metric label="Acknowledged" value={status.outbox?.ACKNOWLEDGED ?? 0} tone="success" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Connection" description="OAuth material is stored encrypted; tokens are never exposed to the browser.">
              <div className="p-4">
                <KV
                  cols={2}
                  items={[
                    { label: 'Company id', value: <span className="code">{status.connection?.company_id ?? '—'}</span> },
                    { label: 'Auth mode', value: status.connection?.auth_mode ?? '—' },
                    { label: 'Token present', value: status.token_present ? 'Yes' : 'No' },
                    { label: 'Refresh token', value: status.has_refresh_token ? 'Yes' : 'No' },
                    { label: 'Token expires', value: <DateTimeText value={status.connection?.token_expires_at} /> },
                    { label: 'Webhook hook', value: status.connection?.webhook_hook_id ?? 'Not registered' },
                    { label: 'Redirect URI', value: <span className="code break-all">{status.redirect_uri}</span> },
                    { label: 'Webhook destination', value: <span className="code break-all">{status.webhook_destination_url}</span> },
                  ]}
                />
                {s.can('integration.manage') ? (
                  <div className="mt-3">
                    <Button size="sm" onClick={() => setShowAuth(true)}>Fetch OAuth authorize URL</Button>
                    {auth.isPending && showAuth ? <p className="mt-2 text-xs text-muted-foreground">Requesting…</p> : null}
                    {auth.isError ? <p className="mt-2 text-xs text-danger">{auth.error.detail}</p> : null}
                    {auth.data?.url || auth.data?.authorize_url ? (
                      <p className="mt-2 break-all text-xs">
                        <a className="text-accent underline-offset-2 hover:underline" href={auth.data.url ?? auth.data.authorize_url} target="_blank" rel="noreferrer">
                          {auth.data.url ?? auth.data.authorize_url}
                        </a>
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Section>

            <Section title="Linked objects" description="Counts of Procore objects mapped to internal records.">
              {Object.keys(status.link_counts ?? {}).length === 0 ? (
                <EmptyState icon={<Link2 />} title="No links yet" message="Run a sync after connecting to import projects, vendors, cost codes and commitments." />
              ) : (
                <Table caption="Linked Procore objects">
                  <THead>
                    <TR>
                      <TH>Object type</TH>
                      <TH numeric>Links</TH>
                      <TH className="text-right">Open</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {Object.entries(status.link_counts ?? {}).map(([type, count]) => (
                      <TR key={type}>
                        <RowHeader>{humanize(type)}</RowHeader>
                        <TD numeric>{count}</TD>
                        <TD className="text-right">
                          <Link className="text-xs font-medium text-accent underline-offset-2 hover:underline" to={`/admin/links?domain_type=${encodeURIComponent(type)}`}>View</Link>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Section>
          </div>

          <Section className="mt-4" title="Outbox by state" description="Procore write-back is asynchronous; unknown outcomes require reconciliation.">
            <Table caption="Procore outbox counts">
              <THead>
                <TR>
                  <TH>State</TH>
                  <TH numeric>Messages</TH>
                </TR>
              </THead>
              <TBody>
                {Object.entries(status.outbox ?? {}).length === 0 ? (
                  <EmptyRow cols={2}>No Procore outbox messages.</EmptyRow>
                ) : (
                  Object.entries(status.outbox ?? {}).map(([st, n]) => (
                    <TR key={st}>
                      <RowHeader><StateBadge state={st} context="outbox" /></RowHeader>
                      <TD numeric>{n}</TD>
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          </Section>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Section title="Embedded launch context" description="Read from the Procore iframe query parameters and handshake.">
              <div className="p-4">
                <KV
                  cols={2}
                  items={[
                    { label: 'Embedded', value: c.embedded ? 'Yes — side panel or iframe' : 'No — full screen' },
                    { label: 'Mapping state', value: humanize(c.mapping.state) },
                    { label: 'Procore company', value: c.launch.companyId ?? '—' },
                    { label: 'Procore project', value: c.launch.projectId ?? '—' },
                    { label: 'Mapped project', value: c.project?.code ?? '—' },
                    { label: 'Programme', value: c.programme?.code ?? '—' },
                    { label: 'Health', value: health.data ? `${humanize(health.data.status)} · simulator ${health.data.procore_mode ?? 'unknown'}` : 'Unknown' },
                    { label: 'App manifest', value: 'See below' },
                  ]}
                />
                {c.mapping.message ? <p className="mt-2 text-xs text-muted-foreground">{c.mapping.message}</p> : null}
              </div>
            </Section>

            <Section title="App manifest" description="Register these URLs and scopes in the Procore developer portal.">
              <div className="p-4">
                {manifest.isPending ? <LoadingBlock rows={4} /> : manifest.isError ? <ErrorPanel error={manifest.error} compact /> : <JsonView label="Manifest JSON" value={manifest.data} />}
              </div>
            </Section>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Inspect queued writes in the <Link className="text-accent underline-offset-2 hover:underline" to="/admin/outbox">outbox</Link>, inbound webhooks in the{' '}
            <Link className="text-accent underline-offset-2 hover:underline" to="/admin/inbox">inbox</Link>, and blocked flows in{' '}
            <Link className="text-accent underline-offset-2 hover:underline" to="/admin/exceptions">exceptions</Link>.
          </p>
        </>
      ) : null}

      <Dialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        title="Connect Procore"
        description="In simulated mode the connector issues a local token. In sandbox or production, fetch the OAuth authorize URL and complete the callback."
        footer={
          <>
            <Button onClick={() => setConnectOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate()}>Connect</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Company id" hint="Blank uses the environment default.">
            <Input value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="123456" />
          </Field>
          <Field label="Auth mode" hint="SIMULATED is only valid when the backend runs in simulated mode.">
            <Input value={authMode} onChange={(e) => setAuthMode(e.target.value.toUpperCase())} placeholder="CLIENT_CREDENTIALS" />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={syncOpen}
        onOpenChange={setSyncOpen}
        title="Select resources to sync"
        description="Sync is idempotent and records conflicts as exceptions rather than overwriting reviewed data."
        footer={
          <>
            <Button onClick={() => setSyncOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={sync.isPending} disabled={!Object.values(picked).some(Boolean)} onClick={() => sync.mutate()}>Run sync</Button>
          </>
        }
      >
        <div className="space-y-2">
          {resources.map((r) => (
            <div key={r} className="rounded px-1 py-1 hover:bg-muted">
              <Checkbox checked={!!picked[r]} onChange={(e) => setPicked({ ...picked, [r]: e.target.checked })} label={<span className="capitalize">{humanize(r)}</span>} />
            </div>
          ))}
          <Callout tone="info" title="Write-back stays deferred">
            Syncing reads Procore into this workspace. Outbound changes are queued and processed separately.
          </Callout>
        </div>
      </Dialog>

      <CommandDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title="Disconnect Procore"
        description="Queued messages keep their state. Reconnecting resumes the same company unless you connect a different one."
        tone="danger"
        confirmLabel="Disconnect"
        run={() => integrations.disconnect()}
        invalidate={[['integrations']]}
        success="Procore disconnected"
        onDone={() => setDisconnectOpen(false)}
        disabled={!status?.connected ? 'No active connection.' : undefined}
      >
        <KV
          cols={2}
          items={[
            { label: 'Company', value: status?.connection?.company_name ?? status?.connection?.company_id ?? '—' },
            { label: 'State', value: <StateBadge state={status?.connection?.state} /> },
          ]}
        />
      </CommandDialog>
    </>
  )
}
