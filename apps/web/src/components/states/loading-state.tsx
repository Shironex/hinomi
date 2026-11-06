import { Skeleton } from '@/components/ui/skeleton'

export type LoadingLayout = 'list' | 'table' | 'detail'

/** Page-shaped skeletons from the design, with a status line for screen readers. */
export function LoadingState({
  layout = 'list',
  label = 'Loading',
}: {
  layout?: LoadingLayout
  label?: string
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2.5" aria-hidden="true">
        <Skeleton className="h-[26px] w-[260px]" />
        <Skeleton className="h-3 w-[440px]" />
      </div>
      {layout === 'detail' ? (
        <DetailSkeleton />
      ) : layout === 'table' ? (
        <TableSkeleton />
      ) : (
        <ListSkeleton />
      )}
      <p role="status" className="sr-only">
        {label}
      </p>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-lg border border-border bg-card">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-border px-4 py-3.5 first:border-t-0 tab:grid-cols-[28px_46px_minmax(0,1fr)_auto]"
        >
          <span className="hidden tab:block" />
          <Skeleton className="hidden h-3.5 w-[46px] tab:block" />
          <span className="flex flex-col gap-[7px]">
            <Skeleton className="h-3.5 w-[200px]" />
            <Skeleton className="h-3 w-[70%]" />
            <Skeleton className="h-2.5 w-[45%]" />
          </span>
          <Skeleton className="h-[26px] w-24" />
        </div>
      ))}
    </div>
  )
}

function TableSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-3"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="size-[18px]" />
          <Skeleton className="h-5 w-16" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-[40%]" />
            <Skeleton className="h-2.5 w-[65%]" />
          </span>
          <Skeleton className="hidden h-3 w-20 tab:block" />
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-7 desk:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card tab:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="flex flex-col gap-2 border-border p-3.5 not-last:border-r">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-3.5 w-24" />
            </span>
          ))}
        </div>
        <Skeleton className="h-[220px] w-full rounded-lg" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-[140px] w-full rounded-lg" />
        <Skeleton className="h-[180px] w-full rounded-lg" />
      </div>
    </div>
  )
}
