import type * as React from 'react'
import { useId } from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export interface FieldControlProps {
  id: string
  'aria-invalid': true | undefined
  'aria-describedby': string | undefined
}

interface FieldProps {
  label: React.ReactNode
  /** Short guidance under the control, read out with it. */
  help?: React.ReactNode
  /** Shown in place of nothing under the control and tied to it with aria-describedby. */
  error?: string | null | undefined
  className?: string
  /** Receives the id and aria wiring for the control. */
  children: (control: FieldControlProps) => React.ReactNode
}

/** Label, control, help and error from the design's .field, wired for screen readers. */
export function Field({ label, help, error, className, children }: FieldProps) {
  const id = useId()
  const helpId = help ? `${id}-help` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      {help ? (
        <span id={helpId} className="text-xs text-muted-foreground">
          {help}
        </span>
      ) : null}
    </div>
  )
}

export function FieldError({
  id,
  children,
}: {
  id?: string | undefined
  children: React.ReactNode
}) {
  return (
    <span id={id} className="flex items-start gap-1.5 text-xs text-sev-critical">
      <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" stroke={1.75} />
      <span>{children}</span>
    </span>
  )
}

/** One row of the design's .opt list: icon, title with a note, and a control on the right. */
export function OptionRow({
  icon,
  title,
  note,
  control,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  note?: React.ReactNode
  control?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0',
        className,
      )}
    >
      {icon ? <span className="shrink-0 text-foreground-2 [&_svg]:size-4">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="font-medium">{title}</b>
        {note ? <small className="text-xs text-muted-foreground">{note}</small> : null}
      </span>
      {control}
    </div>
  )
}
