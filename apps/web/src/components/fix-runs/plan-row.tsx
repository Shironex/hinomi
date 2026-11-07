import type { FixPlanRef, FixRun } from '@hinomi/shared'
import { IconListCheck } from '@tabler/icons-react'
import { RunStateText } from './run-state-text'

const number = new Intl.NumberFormat('en-US')

/** A repo's plan in the fix runs list: what it clears and how its latest run stands. */
export function PlanRow({ plan, latest }: { plan: FixPlanRef; latest: FixRun | undefined }) {
  const s = plan.summary
  return (
    <span className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-1">
      <IconListCheck
        aria-hidden="true"
        className="row-span-2 mt-[3px] size-4 text-accent-ink"
        stroke={1.75}
      />
      <span className="min-w-0 truncate text-sm font-semibold text-foreground">
        Plan: {s.steps.safe} safe step{s.steps.safe === 1 ? '' : 's'}
        {s.steps.risky ? `, ${s.steps.risky} risky` : ''}
      </span>
      <span className="text-right text-md font-semibold text-accent-ink tabular-nums">
        {number.format(s.findings.clearedSafely)}
        <span className="sr-only"> findings cleared safely</span>
      </span>
      <span className="min-w-0 truncate text-xs">
        {latest ? (
          <RunStateText run={latest} />
        ) : (
          <span className="text-muted-foreground">Not run yet</span>
        )}
      </span>
      <span aria-hidden="true" className="text-right text-xs text-muted-foreground">
        cleared
      </span>
    </span>
  )
}
