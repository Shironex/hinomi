import type * as React from 'react'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { describeError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export interface ErrorStateProps {
  title?: string
  error?: unknown
  /** Shows a "Try again" button. */
  onRetry?: () => void
  actions?: React.ReactNode
  className?: string
}

export function ErrorState({
  title = 'This did not load',
  error,
  onRetry,
  actions,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-[color-mix(in_oklch,var(--sev-critical)_25%,transparent)] bg-sev-critical-soft px-5 py-4 tab:flex-row tab:items-center',
        className,
      )}
    >
      <IconAlertTriangle
        aria-hidden="true"
        className="size-5 shrink-0 text-sev-critical"
        stroke={1.75}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="max-w-[68ch] text-sm text-foreground-2">{describeError(error)}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <IconRefresh aria-hidden="true" />
            Try again
          </Button>
        ) : null}
        {actions}
      </div>
    </div>
  )
}
