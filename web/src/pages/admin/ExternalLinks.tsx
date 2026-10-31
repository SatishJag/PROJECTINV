import { Link2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { integrations } from '@/api/endpoints'
import { useApi } from '@/api/hooks'
import type { ExternalObjectLink } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form'
import { DateTimeText, EmptyState, Mono, PageHeader, QueryView, Section } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, RowHeader, EmptyRow } from '@/components/ui/table'
import { asList, humanize } from '@/lib/utils'

const DOMAINS = [
  'physical_unit',
  'purchase_order',
  'sourcing_package',
  'requirement',
  'requirement_revision',
  'recovery_case',
  'handbook_package',
  'project',
  'supplier',
  'cost_event',
] as const

function internalHref(l: ExternalObjectLink): string | null {
  switch (l.domain_type) {
    case 'physical_unit':
      return `/delivery/units/${l.domain_id}`
    case 'purchase_order':
      return `/delivery/purchase-orders/${l.domain_id}`
    case 'sourcing_package':
      return `/sourcing/packages/${l.domain_id}`
    case 'requirement':
      return `/planning/requirements/${l.domain_id}`
    case 'recovery_case':
      return `/delivery/recovery/${l.domain_id}`
    case 'handbook_package':
      return `/handbook/packages/${l.domain_id}`
    default:
      return null
  }
}

export function ExternalLinks() {
  const [params, setParams] = useSearchParams()
  const [domainType, setDomainType] = useState(params.get('domain_type') ?? '')
  const [domainId, setDomainId] = useState(params.get('domain_id') ?? '')
  const [platform, setPlatform] = useState(params.get('platform') ?? '')

  const q = useApi(
    ['integrations', 'links', domainType, domainId, platform],
    integrations.links({ domain_type: domainType || undefined, domain_id: domainId || undefined, platform: platform || undefined }),
    { enabled: !!domainType || !!domainId },
  )
  const rows = asList<ExternalObjectLink>(q.data)

  const apply = () => {
    const next = new URLSearchParams()
    if (domainType) next.set('domain_type', domainType)
    if (domainId.trim()) next.set('domain_id', domainId.trim())
    if (platform) next.set('platform', platform)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="External links"
        description="The identity map between internal records and Procore, Oracle and Planon objects. Link keys drive idempotent write-back."
      />

      <Section title="Filters" description="Filter by internal domain subject or platform object type.">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Domain type">
            <Select value={domainType} onChange={(e) => setDomainType(e.target.value)}>
              <option value="">Any domain</option>
              {DOMAINS.map((d) => <option key={d} value={d}>{humanize(d)}</option>)}
            </Select>
          </Field>
          <Field label="Domain id" hint="Exact internal record id.">
            <Input value={domainId} onChange={(e) => setDomainId(e.target.value)} placeholder="a1b2c3…" />
          </Field>
          <Field label="Platform">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">Any platform</option>
              <option value="PROCORE">Procore</option>
              <option value="ORACLE">Oracle</option>
              <option value="PLANON">Planon</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button variant="primary" onClick={apply} disabled={!domainType && !domainId.trim()}>Apply filters</Button>
          </div>
        </div>
      </Section>

      <Section className="mt-4" title={`${domainType || domainId ? rows.length : 0} link${rows.length === 1 ? '' : 's'}`} description="Choose a domain type or id to inspect the mapping.">
        {!domainType && !domainId ? (
          <EmptyState icon={<Link2 />} title="Choose a filter" message="The link register can be large; filter by domain or record id. Procore connection counts link here too." />
        ) : (
          <QueryView q={q} rows={6} empty={<EmptyState icon={<Link2 />} title="No links" message="This record has not been linked to an external object yet." />}>
            {() => (
              <Table caption="External object links">
                <THead>
                  <TR>
                    <TH>Platform</TH>
                    <TH>Object</TH>
                    <TH>Company / project</TH>
                    <TH>Internal record</TH>
                    <TH>Role</TH>
                    <TH>Source revision</TH>
                    <TH>Sync state</TH>
                    <TH>Last synced</TH>
                    <TH className="text-right">Open</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.length === 0 ? (
                    <EmptyRow cols={9}>No links for this filter.</EmptyRow>
                  ) : (
                    rows.map((l) => {
                      const href = internalHref(l)
                      return (
                        <TR key={l.id}>
                          <RowHeader>{l.platform}</RowHeader>
                          <TD>
                            {humanize(l.object_type)}
                            <span className="block code text-[11px]">{l.object_key}</span>
                          </TD>
                          <TD>
                            <span className="code text-[11px]">{l.company_key}</span>
                            {l.project_key ? <span className="block code text-[11px] text-muted-foreground">{l.project_key}</span> : null}
                          </TD>
                          <TD>
                            {humanize(l.domain_type)}
                            <span className="block text-[11px] text-muted-foreground"><Mono>{l.domain_id.slice(0, 10)}</Mono></span>
                          </TD>
                          <TD>{humanize(l.link_role)}</TD>
                          <TD>{l.source_revision ? <span className="code">{l.source_revision}</span> : '—'}</TD>
                          <TD>{humanize(l.sync_state)}</TD>
                          <TD><DateTimeText value={l.last_synced_at} /></TD>
                          <TD className="text-right">
                            {href ? <Link className="text-xs font-medium text-accent underline-offset-2 hover:underline" to={href}>Record</Link> : <span className="text-muted-foreground">—</span>}
                          </TD>
                        </TR>
                      )
                    })
                  )}
                </TBody>
              </Table>
            )}
          </QueryView>
        )}
      </Section>
    </>
  )
}
