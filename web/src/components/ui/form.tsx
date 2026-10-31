import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, cloneElement, isValidElement, type ReactElement } from 'react'
import { cn } from '@/lib/utils'

const control =
  'w-full rounded-md border border-input bg-card px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, 'h-8', className)} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-[72px] py-1.5 leading-snug', className)} {...props} />
})

/** Native select: fully keyboard/screen-reader accessible, styled to match. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        'h-8 appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2016%2016%27%20fill%3D%27none%27%20stroke%3D%27%23586273%27%20stroke-width%3D%271.6%27%3E%3Cpath%20d%3D%27m4%206%204%204%204-4%27/%3E%3C/svg%3E")] bg-[length:14px] bg-[right_8px_center] bg-no-repeat pr-7',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
})

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-foreground', className)} {...props} />
}

/**
 * Labelled field. Wires id / aria-describedby / aria-invalid onto the single child control.
 */
export function Field({ label, hint, error, required, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactElement; className?: string }) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errId = error ? `${id}-err` : undefined
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
        required,
      })
    : children
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="text-danger" aria-hidden>
            {' '}
            *
          </span>
        ) : null}
      </Label>
      {child}
      {hint ? (
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-[11px] font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-[13px]', className)}>
      <input type="checkbox" className="size-4 rounded border-input accent-[var(--accent)]" {...props} />
      <span>{label}</span>
    </label>
  )
}
