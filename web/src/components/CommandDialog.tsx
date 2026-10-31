import { useState, type ReactNode } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { describeError, isApiError } from '@/api/client'
import { useCommand } from '@/api/hooks'
import { Callout } from './common'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'
import { Field, Textarea } from './ui/form'

/**
 * Confirmation dialog for a guarded command. Shows the concrete subject (children),
 * optionally collects a reason, renders server problems inline and handles 412/428
 * with a "reload to review" path that refreshes the affected queries.
 */
export function CommandDialog<R = unknown>({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'primary',
  reason,
  children,
  run,
  invalidate = [],
  success,
  onDone,
  disabled,
  size = 'md',
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  tone?: 'primary' | 'danger'
  reason?: { label: string; required?: boolean; placeholder?: string; hint?: string }
  children?: ReactNode
  run: (reason: string) => Promise<R>
  invalidate?: QueryKey[]
  success?: string
  onDone?: (r: R) => void
  disabled?: boolean | string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const cmd = useCommand<string, R>({
    run,
    invalidate,
    success,
    silent: true,
    onSuccess: (r) => {
      setText('')
      setTouched(false)
      onOpenChange(false)
      onDone?.(r)
    },
  })
  const reasonMissing = !!reason?.required && text.trim().length === 0
  const err = cmd.error
  const isConflict = isApiError(err) && (err.status === 412 || err.status === 428)
  const d = err ? describeError(err) : null

  const close = (o: boolean) => {
    if (!o) cmd.reset()
    onOpenChange(o)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={cmd.isPending}
            disabled={!!disabled || isConflict}
            onClick={() => {
              setTouched(true)
              if (reasonMissing) return
              cmd.mutate(text.trim())
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {reason ? (
          <Field label={reason.label} required={reason.required} hint={reason.hint} error={touched && reasonMissing ? 'A reason is required for the audit trail.' : undefined}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={reason.placeholder} />
          </Field>
        ) : null}
        {typeof disabled === 'string' ? <Callout tone="warning">{disabled}</Callout> : null}
        {d ? (
          <Callout
            tone={isConflict ? 'warning' : 'danger'}
            title={d.title}
            actions={
              isConflict ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })))
                    close(false)
                  }}
                >
                  Reload to review
                </Button>
              ) : undefined
            }
          >
            {d.message}
            {d.code ? <span className="code ml-1 text-[10px] text-muted-foreground">({d.code})</span> : null}
          </Callout>
        ) : null}
      </div>
    </Dialog>
  )
}

/** Small helper: a button that opens a CommandDialog. */
export function useDialog(): [boolean, (o: boolean) => void, () => void] {
  const [open, setOpen] = useState(false)
  return [open, setOpen, () => setOpen(true)]
}
