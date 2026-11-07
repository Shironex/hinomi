import type { FixRun } from '@hinomi/shared'
import { StatusText } from '@/components/findings/finding-state'
import { RUN_STATE_INFO, runSummary } from '@/lib/fix-run-meta'
import { cn } from '@/lib/utils'

/** A fix run's state as a toned icon and words, with its pull request number once it has one. */
export function RunStateText({
  run,
  className,
}: {
  run: Pick<FixRun, 'state' | 'pr'>
  className?: string
}) {
  const info = RUN_STATE_INFO[run.state]
  return (
    <StatusText
      icon={info.icon}
      tone={info.tone}
      className={cn(info.spin && 'motion-safe:[&>svg]:animate-spin', className)}
    >
      {runSummary(run)}
    </StatusText>
  )
}
