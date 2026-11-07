import type { FixRun } from '@hinomi/shared'
import { formatRelative } from '@/lib/format'
import { RunStateText } from './run-state-text'

/** One fix run in the list: its state, when it started and its pull request. */
export function FixRunRow({ run }: { run: FixRun }) {
  return (
    <span className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5">
      <span aria-hidden="true" />
      <RunStateText run={run} className="min-w-0 truncate" />
      <span className="text-xs text-muted-foreground">{formatRelative(run.at.created)}</span>
      <span aria-hidden="true" />
      <span className="col-span-2 truncate text-xs text-muted-foreground">
        {run.kind === 'majors' ? 'Majors run' : 'Run'} {run.id}
        {run.pr ? `, PR #${run.pr.number}${run.pr.draft ? ' draft' : ''}` : ''}
      </span>
    </span>
  )
}
