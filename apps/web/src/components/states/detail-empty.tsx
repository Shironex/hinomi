import type * as React from 'react'
import type { Icon } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

/**
 * The design's .empty for a split view's detail pane (and the phone list): a 52 px accent tile,
 * a title, what will appear here and how to get it there, then the way forward.
 */
export function DetailEmpty({
  icon: IconCmp,
  title,
  children,
  actions,
  className,
}: {
  icon: Icon
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex max-w-[560px] flex-col items-start gap-3', className)}>
      <span
        aria-hidden="true"
        className="grid size-[52px] place-items-center rounded-[14px] bg-accent text-accent-ink"
      >
        <IconCmp className="size-[26px]" stroke={1.75} />
      </span>
      <h2 className="text-lg">{title}</h2>
      <div className="flex flex-col gap-2 text-base text-pretty text-foreground-2">{children}</div>
      {actions ? <div className="mt-1 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
