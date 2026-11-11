import { useState } from 'react'
import { Link } from 'react-router'
import { reference, step1 } from '@/api/endpoints'
import { useApi, useCommand } from '@/api/hooks'
import type { Step1Decision, Step1Item } from '@/api/types'
import { useSession } from '@/auth/AuthProvider'
import { CommandDialog } from '@/components/CommandDialog'
import { Button } from '@/components/ui/button'
import { Field, Select } from '@/components/ui/form'
import { Mono, PageHeader, QueryView, Section, StateBadge } from '@/components/common'
import { Table, THead, TBody, TR, TH, TD, EmptyRow } from '@/components/ui/table'

const FILTERS: { value: Step1Decision; label: string }[] = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'LLE', label: 'Long-lead' },
  { value: 'NOT_LLE', label: 'Not long-lead' },
]

type Dialog = { kind: 'class' | 'not-lle'; item: Step1Item }

export function Step1Items() {
  const s = useSession()
  const canClassify = s.can('step1.classify')
  const [decision, setDecision] = useState<Step1Decision>('PENDING')
  const [dialog, setDialog] = useState<Dialog | null>(null)

  const q = useApi(['step1', 'items', decision], step1.items(decision))

  const confirm = useCommand({
    run: (item: Step1Item) => step1.classify(item.id, { decision: 'LLE', equipment_class_id: item.suggested_class_id }, { ifMatch: item.etag }),
    invalidate: [['step1']],
    success: 'Classified as long-lead',
  })

  const cols = canClassify ? 6 : 5

  return (
    <>
      <PageHeader
        eyebrow="Planning & BOQ"
        title="Step 1 items"
        description="Items seen in the Step 1 register that need a long-lead decision before they become PCX requirements."
        actions={
          <div className="w-44">
            <Field label="Decision">
              <Select value={decision} onChange={(e) => setDecision(e.target.value as Step1Decision)}>
                {FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        }
      />

      <Section title="Register items" description="Confirm the suggested equipment class, choose another, or mark the item as not long-lead.">
        <QueryView q={q} rows={4}>
          {(rows) => (
            <Table caption={`Step 1 items: ${FILTERS.find((f) => f.value === decision)?.label}`}>
              <THead>
                <TR>
                  <TH>Item code</TH>
                  <TH>Description</TH>
                  <TH>Suggested class</TH>
                  <TH>Decision</TH>
                  <TH numeric>Requirements</TH>
                  {canClassify ? <TH>Actions</TH> : null}
                </TR>
              </THead>
              <TBody>
                {rows.length === 0 ? (
                  <EmptyRow cols={cols}>No {FILTERS.find((f) => f.value === decision)?.label.toLowerCase()} items.</EmptyRow>
                ) : (
                  rows.map((it) => (
                    <TR key={it.id}>
                      <TD><Mono className="whitespace-nowrap">{it.internal_item_code ?? it.step1_item_id}</Mono></TD>
                      <TD className="min-w-48">{it.description}</TD>
                      <TD>{it.suggested_class_name ?? <span className="text-muted-foreground">No suggestion</span>}</TD>
                      <TD>
                        <StateBadge state={it.decision} />
                        {it.decision_reason ? <p className="mt-1 max-w-xs text-xs text-muted-foreground">{it.decision_reason}</p> : null}
                      </TD>
                      <TD numeric>{it.requirement_count}</TD>
                      {canClassify ? (
                        <TD>
                          <div className="flex flex-wrap gap-1.5">
                            {it.suggested_class_id && it.decision === 'PENDING' ? (
                              <Button size="sm" variant="primary" loading={confirm.isPending && confirm.variables?.id === it.id} onClick={() => confirm.mutate(it)}>
                                Confirm suggestion
                              </Button>
                            ) : null}
                            <Button size="sm" onClick={() => setDialog({ kind: 'class', item: it })}>
                              Choose class…
                            </Button>
                            <Button size="sm" onClick={() => setDialog({ kind: 'not-lle', item: it })}>
                              Not long-lead
                            </Button>
                          </div>
                        </TD>
                      ) : null}
                    </TR>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </QueryView>
      </Section>

      <p className="mt-4 text-xs text-muted-foreground">
        Classifying an item does not create requirements. They are created or revised at the next Step 1 sync (see{' '}
        <Link className="text-accent underline-offset-2 hover:underline" to="/admin/step1">Step 1 feed</Link>).
      </p>

      {dialog?.kind === 'class' ? <ChooseClassDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'not-lle' ? <NotLongLeadDialog key={dialog.item.id} item={dialog.item} onClose={() => setDialog(null)} /> : null}
    </>
  )
}

function ChooseClassDialog({ item, onClose }: { item: Step1Item; onClose: () => void }) {
  const classes = useApi(['step1', 'equipment-classes'], reference.equipmentClasses(), { staleTime: 10 * 60_000 })
  const [classId, setClassId] = useState(item.equipment_class_id ?? item.suggested_class_id ?? '')
  const options = (classes.data ?? []).filter((c) => !c.is_component_class)

  return (
    <CommandDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="Choose equipment class"
      description={item.description}
      confirmLabel="Mark as long-lead"
      disabled={!classId || classes.isPending}
      run={() => step1.classify(item.id, { decision: 'LLE', equipment_class_id: classId }, { ifMatch: item.etag })}
      invalidate={[['step1']]}
      success="Classified as long-lead"
    >
      <Field label="Equipment class" required hint="Component classes are not offered here.">
        <Select value={classId} onChange={(e) => setClassId(e.target.value)} disabled={classes.isPending}>
          <option value="">Select a class…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.code})
            </option>
          ))}
        </Select>
      </Field>
      {classes.isError ? <p role="alert" className="text-xs font-medium text-danger">Equipment classes could not be loaded.</p> : null}
    </CommandDialog>
  )
}

function NotLongLeadDialog({ item, onClose }: { item: Step1Item; onClose: () => void }) {
  return (
    <CommandDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="Mark as not long-lead"
      description={item.description}
      confirmLabel="Mark as not long-lead"
      reason={{ label: 'Reason', required: true, placeholder: 'Why this item is not long-lead', hint: 'Recorded in the audit trail.' }}
      run={(reason) => step1.classify(item.id, { decision: 'NOT_LLE', reason }, { ifMatch: item.etag })}
      invalidate={[['step1'], ['integrations']]}
      success="Classified as not long-lead"
    />
  )
}
