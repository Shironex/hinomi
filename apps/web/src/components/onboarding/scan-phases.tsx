import { SCAN_PHASES, type ScanPhase } from '@hinomi/shared'
import { IconCheck, IconMinus, IconRefresh } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { describeScanning, PHASE_LABEL, phaseCount, type ScanningStatus } from '@/lib/scan-phases'

type LineState = 'done' | 'active' | 'pending' | 'skipped'

function lineState(phase: ScanPhase, status: ScanningStatus | null): LineState {
  if (!status) return phase === SCAN_PHASES[0] ? 'active' : 'pending'
  if (status.skipped.includes(phase)) return 'skipped'
  const at = SCAN_PHASES.indexOf(status.phase)
  const index = SCAN_PHASES.indexOf(phase)
  return index < at ? 'done' : index === at ? 'active' : 'pending'
}

/** What each phase does, under its name while it is not running. */
const PHASE_NOTE: Record<ScanPhase, string> = {
  deployments: 'Apps, domains and servers from Coolify',
  alerts: 'Dependabot alerts of every repo',
  lockfiles: 'Package versions checked against OSV.dev',
  matching: 'Each app joined with the repo it runs',
  ranking: 'Public and critical first',
}

const percent = (status: ScanningStatus) =>
  Math.max(1, Math.round((status.done / status.total) * 100))

/**
 * The five phases of a running scan, from the design's first scan board: done phases are
 * checked, the current one turns with its count, percentage and a bar, later ones wait.
 * `status` is null while the scan is starting and its first status has not arrived.
 */
export function ScanPhases({ status }: { status: ScanningStatus | null }) {
  return (
    <ol
      aria-label="Scan phases"
      className="flex flex-col rounded-lg border border-border bg-card px-5 py-1"
    >
      {SCAN_PHASES.map((phase) => {
        const state = lineState(phase, status)
        const known = state === 'active' && status !== null && status.total > 0
        const word =
          state === 'done'
            ? 'Done'
            : state === 'skipped'
              ? 'Skipped'
              : state === 'pending'
                ? 'Waiting'
                : known
                  ? `${percent(status)}%`
                  : 'Starting'
        const sub =
          state === 'active' && status
            ? (phaseCount(status) ?? PHASE_NOTE[phase])
            : PHASE_NOTE[phase]
        return (
          <li
            key={phase}
            aria-current={state === 'active' ? 'step' : undefined}
            className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-0.5 border-t border-border py-3.5 first:border-t-0"
          >
            <PhaseIcon state={state} />
            <b
              className={cn(
                'min-w-0 font-semibold',
                (state === 'pending' || state === 'skipped') && 'text-foreground-2',
              )}
            >
              {PHASE_LABEL[phase]}
            </b>
            <span className="sr-only">, </span>
            <span
              className={cn(
                'col-start-3 row-start-1 text-sm tabular-nums',
                state === 'active' ? 'font-semibold text-accent-ink' : 'text-muted-foreground',
              )}
            >
              {word}
            </span>
            <span className="sr-only">, </span>
            <small className="col-start-2 text-xs text-muted-foreground">{sub}</small>
            {state === 'active' ? <PhaseBar status={status} /> : null}
          </li>
        )
      })}
    </ol>
  )
}

function PhaseIcon({ state }: { state: LineState }) {
  const base = 'grid size-6 place-items-center rounded-full'
  if (state === 'done') {
    return (
      <span aria-hidden="true" className={cn(base, 'bg-success-soft text-success')}>
        <IconCheck className="size-3.5" stroke={2.4} />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span aria-hidden="true" className={cn(base, 'bg-accent text-accent-ink')}>
        <IconRefresh
          className="size-3.5 animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none"
          stroke={2}
        />
      </span>
    )
  }
  if (state === 'skipped') {
    return (
      <span aria-hidden="true" className={cn(base, 'bg-muted text-muted-foreground')}>
        <IconMinus className="size-3.5" stroke={2} />
      </span>
    )
  }
  return <span aria-hidden="true" className={cn(base, 'border border-dashed border-input')} />
}

function PhaseBar({ status }: { status: ScanningStatus | null }) {
  const known = status !== null && status.total > 0
  const label = status ? describeScanning(status) : 'Starting the scan'
  return (
    <div
      role="progressbar"
      aria-label="First scan"
      aria-valuemin={0}
      aria-valuemax={known ? status.total : undefined}
      aria-valuenow={known ? status.done : undefined}
      aria-valuetext={label}
      className="col-span-2 col-start-2 mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={
          known
            ? 'h-full rounded-full bg-primary transition-[width] duration-500'
            : 'h-full w-1/3 animate-pulse rounded-full bg-primary/60 motion-reduce:animate-none'
        }
        style={known ? { width: `${percent(status)}%` } : undefined}
      />
    </div>
  )
}
