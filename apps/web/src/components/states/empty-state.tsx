import type * as React from 'react'
import type { Icon } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  icon: Icon
  title: string
  children?: React.ReactNode
  /** Buttons or links that move the user forward. */
  actions?: React.ReactNode
  className?: string
}

/** Teaches what will appear here and how to get it there, never just "nothing here". */
export function EmptyState({
  icon: IconCmp,
  title,
  children,
  actions,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-dashed border-input bg-card px-6 py-8 tab:flex-row tab:items-center tab:gap-5',
        className,
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-foreground-2">
        <IconCmp aria-hidden="true" className="size-5" stroke={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-md">{title}</h2>
        {children ? (
          <div className="max-w-[62ch] text-sm text-pretty text-muted-foreground">{children}</div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
