import { useQuery } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'
import { scanStatusQuery } from '@/lib/queries'

/** A running scan, above a view's results, so stale numbers are never mistaken for fresh ones. */
export function ScanStrip({ what = 'Results below' }: { what?: string }) {
  const { data } = useQuery(scanStatusQuery)
  if (data?.state !== 'scanning') return null
  const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0
  return (
    <div
      role="status"
      className="mb-3.5 flex flex-col gap-2 rounded-lg border border-[color-mix(in_oklch,var(--primary)_25%,transparent)] bg-accent px-3.5 py-2.5 text-sm text-foreground-2"
    >
      <div className="flex items-center gap-2">
        <IconLoader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin text-accent-ink motion-reduce:animate-none"
        />
        <span>
          <b className="font-semibold text-foreground">Scanning.</b>{' '}
          {data.total > 0
            ? `${data.done} of ${data.total} repos looked at. `
            : 'Reading the deployments. '}
          {what} are from the previous scan until it ends.
        </span>
      </div>
      <span
        aria-hidden="true"
        className="block h-[3px] overflow-hidden rounded-[2px] bg-[color-mix(in_oklch,var(--primary)_18%,transparent)]"
      >
        <span
          className="block h-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  )
}
