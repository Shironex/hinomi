import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SplitListFooter } from '@/components/split/split-parts'
import { cn } from '@/lib/utils'

const number = new Intl.NumberFormat('en-US')

export interface SegmentTab<K extends string> {
  key: K
  label: string
  count?: number | null
}

/**
 * The views of a list pane as a segmented control. Each is a link that sets `search[param]`, so
 * a tab survives a reload and can be shared; switching clears the selection.
 */
export function SegmentTabs<K extends string>({
  tabs,
  current,
  param,
  label,
}: {
  tabs: readonly SegmentTab<K>[]
  current: K
  param: string
  label: string
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto rounded-md max-tab:gap-0 border border-border bg-sidebar p-[3px]"
    >
      {tabs.map((tab, i) => {
        const on = tab.key === current
        return (
          <Link
            key={tab.key}
            to="."
            search={
              ((prev: Record<string, unknown>) => ({
                ...prev,
                [param]: i === 0 ? undefined : tab.key,
                sel: undefined,
              })) as never
            }
            replace
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-sm max-tab:gap-1 max-tab:px-1.5 font-[550] whitespace-nowrap no-underline',
              on ? 'bg-muted text-foreground' : 'text-foreground-2 hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count != null ? ' ' : null}
            {tab.count != null ? (
              <span
                className={cn(
                  'tabular-nums',
                  on ? 'font-semibold text-accent-ink' : 'text-muted-foreground',
                )}
              >
                {number.format(tab.count)}
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}

/** "7 of 267 loaded", a button for the next page, and how the list is ordered. */
export function LoadedFooter({
  loaded,
  total,
  noun = '',
  order,
  hasMore,
  loading,
  onMore,
  children,
}: {
  loaded: number
  total: number
  noun?: string
  order: string
  hasMore: boolean
  loading: boolean
  onMore: () => void
  children?: ReactNode
}) {
  return (
    <>
      {children}
      <SplitListFooter className="flex-wrap">
        <span aria-hidden="true" className="size-2 rounded-full bg-success" />
        <span aria-live="polite">
          {number.format(loaded)} of {number.format(total)}
          {noun ? ` ${noun}` : ''} loaded
        </span>
        {hasMore ? (
          <Button variant="ghost" size="xs" disabled={loading} onClick={onMore}>
            {loading ? 'Loading' : 'Load more'}
          </Button>
        ) : null}
        <span className="ml-auto text-muted-foreground">{order}</span>
      </SplitListFooter>
    </>
  )
}

/** Placeholder rows while the first page loads. */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <div>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex flex-col gap-2 border-b border-border px-[18px] py-[15px] pl-[52px]"
        >
          <Skeleton className="h-5 w-[180px]" />
          <Skeleton className="h-4 w-[85%]" />
          <Skeleton className="h-3 w-[45%]" />
        </div>
      ))}
      <p role="status" className="sr-only">
        {label}
      </p>
    </div>
  )
}
