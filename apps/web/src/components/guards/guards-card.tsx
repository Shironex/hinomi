import type { GuardLevel, OverviewResponse } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import { IconArrowRight, IconShieldCheck, IconShieldHalf } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Panel, PanelBody, PanelHeader } from '@/components/views/panel'
import {
  GUARD_LEVEL_LABEL,
  GUARD_LEVELS_WORST_FIRST,
  guardCountRows,
  guardLevelTotals,
} from '@/lib/guard-meta'
import { cn } from '@/lib/utils'
import { GUARD_CHECK_ICON } from './guard-badges'

const number = new Intl.NumberFormat('en-US')

/** Ink per level for counts: fail reads like high, warn like moderate, unknown stays quiet. */
const LEVEL_TONE: Record<GuardLevel, string> = {
  fail: 'text-sev-high',
  warn: 'text-sev-moderate',
  unknown: 'text-muted-foreground',
}

/** "2 fail, 5 warn, 1 unknown" as small counts, zeros left out. */
export function GuardLevelCounts({
  counts,
  className,
}: {
  counts: Record<GuardLevel, number>
  className?: string
}) {
  const parts = GUARD_LEVELS_WORST_FIRST.filter((level) => counts[level] > 0)
  if (!parts.length) return <span className="text-xs text-muted-foreground">None</span>
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2.5 gap-y-1', className)}>
      {parts.map((level) => (
        <span
          key={level}
          className={cn('text-xs font-semibold whitespace-nowrap tabular-nums', LEVEL_TONE[level])}
        >
          {number.format(counts[level])} {GUARD_LEVEL_LABEL[level].toLowerCase()}
        </span>
      ))}
    </span>
  )
}

/**
 * The guards card of the overview: guard findings that are not fixed (turned off ones included)
 * per check, worst first, each linking to the guards view filtered on that check.
 */
export function GuardsCard({
  counts,
  className,
}: {
  counts: OverviewResponse['guardCounts']
  className?: string
}) {
  const rows = guardCountRows(counts)
  const totals = guardLevelTotals(counts)
  return (
    <Panel className={className}>
      <PanelHeader title="Guards" icon={IconShieldHalf}>
        <GuardLevelCounts counts={totals} />
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-foreground-2">
            <IconShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-success"
              stroke={1.75}
            />
            No guard finding. Every check passes, or no scan has run a check yet.
          </p>
        ) : (
          <ul aria-label="Guard findings per check" className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => {
              const IconCmp = GUARD_CHECK_ICON[row.check]
              return (
                <li key={row.check} className="border-t border-border first:border-t-0">
                  <Link
                    to="/guards"
                    search={{ check: [row.check] }}
                    className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 text-sm text-inherit no-underline hover:text-accent-ink"
                  >
                    <IconCmp
                      aria-hidden="true"
                      className="size-4 text-foreground-2"
                      stroke={1.75}
                    />
                    <span className="truncate">{row.title}</span>
                    <GuardLevelCounts counts={row.counts} />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
        <Button asChild variant="ghost" size="sm" className="self-start">
          <Link to="/guards">
            Open guards
            <IconArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </PanelBody>
    </Panel>
  )
}
