import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The list pane header: the view's h1, a short count on the right, then filters or segments. */
export function SplitListHeader({
  title,
  meta,
  children,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-border px-[18px] pt-[18px] pb-3',
        className,
      )}
    >
      <div className="flex items-baseline gap-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        {meta ? <span className="ml-auto text-xs text-muted-foreground">{meta}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** The list pane footer: how much is loaded and how it is ordered. */
export function SplitListFooter({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'mt-auto flex items-center gap-2 border-t border-border px-[18px] py-3 text-xs text-foreground-2',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A group heading between list rows ("Exposed on a public app 267"). */
export function SplitListGroup({ label, count }: { label: ReactNode; count?: ReactNode }) {
  return (
    <li
      role="presentation"
      className="flex items-center gap-2.5 border-b border-border bg-muted px-[18px] py-2.5 text-sm font-semibold"
    >
      {label}
      {count != null ? <span className="font-normal text-foreground-2">{count}</span> : null}
    </li>
  )
}
