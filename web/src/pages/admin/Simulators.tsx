import { FlaskConical, RotateCcw, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { integrations } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import { useSession } from '@/auth/AuthProvider'
import { Button } from '@/components/ui/button'
import { Callout, ErrorPanel, LoadingBlock, Mono, PageHeader, Section, StateBadge, Unknown } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader } from '@/components/ui/table'

interface SimData {
  modes?: Record<string, string>
  targets?: string[]
  available?: string[]
}

const DESCRIPTIONS: Record<string, string> = {
  ACK: 'Target accepts the write and returns an identifier.',
  REJECT: 'Target rejects with a business error; the message becomes REJECTED and raises an exception.',
  TIMEOUT: 'No response in time; outcome is recorded as unconfirmed and must be reconciled.',
  TRANSIENT: 'Temporary failure; the outbox retries with backoff.',
}

export function Simulators() {
  const s = useSession()
  const [pending, setPending] = useState<string | null>(null)
  const q = useApi(['integrations', 'simulators'], integrations.simulators)
  const data = q.data as SimData | undefined
  const targets = data?.targets ?? ['ORACLE', 'PLANON', 'PROCORE']
  const modes = data?.available ?? ['ACK', 'REJECT', 'TIMEOUT', 'TRANSIENT']

  const setMode = useCommand({
    run: (v: { target: string; mode: string }) => integrations.setSimulatorMode(v.target, v.mode),
    invalidate: [['integrations', 'simulators']],
    success: 'Simulator mode updated',
    onSuccess: () => setPending(null),
  })

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Integration simulators"
        description="Process-local response mode for the Oracle, Planon and Procore simulators. Switch modes to exercise failure handling end to end."
      />

      <Callout className="mb-4" tone="warning" icon={<ShieldAlert />} title="Modes affect every tenant on this process">
        A simulator mode stays until changed or the backend restarts. REJECT and TIMEOUT write exceptions; TRANSIENT exercises retry backoff.
      </Callout>

      {q.isPending ? <LoadingBlock rows={6} label="Loading simulator modes" /> : null}
      {q.isError ? <ErrorPanel error={q.error} onRetry={() => void q.refetch()} /> : null}

      {data ? (
        <Section title="Current modes" description="Choose one response mode per target. Commands are audited when the target is used, not when the mode is changed.">
          <Table caption="Simulator modes">
            <THead>
              <TR>
                <TH>Target</TH>
                <TH>Mode</TH>
                <TH>Behaviour</TH>
                <TH className="text-right">Set mode</TH>
              </TR>
            </THead>
            <TBody>
              {targets.map((t) => {
                const current = data.modes?.[t] ?? 'ACK'
                return (
                  <TR key={t}>
                    <RowHeader><span className="font-semibold">{t}</span></RowHeader>
                    <TD><StateBadge state={current} /></TD>
                    <TD className="text-xs text-muted-foreground">{DESCRIPTIONS[current] ?? <Unknown reason="No description for this mode" />}</TD>
                    <TD>
                      <div className="flex flex-wrap justify-end gap-1">
                        {modes.map((m) => (
                          <Button
                            key={m}
                            size="sm"
                            variant={m === current ? 'primary' : 'secondary'}
                            loading={setMode.isPending && pending === `${t}:${m}`}
                            disabled={!s.can('integration.manage')}
                            onClick={() => {
                              setPending(`${t}:${m}`)
                              setMode.mutate({ target: t, mode: m })
                            }}
                            aria-pressed={m === current}
                          >
                            {m}
                          </Button>
                        ))}
                      </div>
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        </Section>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="What each mode produces" description="Use the outbox and exceptions to observe the result.">
          <ul className="space-y-2 p-4 text-[13px]">
            <li><span className="font-medium">ACK</span> → message becomes <span className="code">ACKNOWLEDGED</span> with an external reference.</li>
            <li><span className="font-medium">REJECT</span> → message becomes <span className="code">REJECTED</span>; an integration exception opens for the owner role.</li>
            <li><span className="font-medium">TIMEOUT</span> → message becomes <span className="code">TIMEOUT_UNKNOWN</span>; reconcile before retrying.</li>
            <li><span className="font-medium">TRANSIENT</span> → message stays pending with an incremented attempt and backoff.</li>
          </ul>
        </Section>
        <Section title="Failure drills" description="Short paths to verify the resilience behaviour.">
          <div className="space-y-2 p-4 text-[13px]">
            <p>1. Set PROCORE to TIMEOUT, approve a routine command, then inspect the <Link className="text-accent underline-offset-2 hover:underline" to="/admin/outbox">outbox</Link>.</p>
            <p>2. Reconcile the unknown message, then reset the simulator to ACK.</p>
            <p>3. Set ORACLE to REJECT and issue an allocation; a <Link className="text-accent underline-offset-2 hover:underline" to="/admin/exceptions">blocking exception</Link> appears until resolved.</p>
            <p className="text-xs text-muted-foreground">Reset by choosing ACK for every target. <RotateCcw className="inline size-3" aria-hidden /> No data is deleted.</p>
          </div>
        </Section>
      </div>

      {!s.can('integration.manage') ? (
        <p className="mt-4 text-xs text-muted-foreground"><FlaskConical className="mr-1 inline size-3" aria-hidden /> Read-only: simulator changes require the Integration or Administrator role. Mode <Mono>{data?.modes?.PROCORE ?? 'ACK'}</Mono>.</p>
      ) : null}
    </>
  )
}
