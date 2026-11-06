import { SCAN_PHASES, type ScanPhase } from '@hinomi/shared'
import { IconCircleCheck, IconCircleMinus, IconClock, IconLoader2 } from '@tabler/icons-react'
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

const ICON = {
  done: IconCircleCheck,
  active: IconLoader2,
  pending: IconClock,
  skipped: IconCircleMinus,
} as const

/**
 * The phase lines of a running scan: done phases are checked, the current
 * one spins with its count and a bar, later ones wait. `status` is null while
 * the scan is starting and its first status has not arrived.
 */
export function ScanPhases({ status }: { status: ScanningStatus | null }) {
  const count = status ? phaseCount(status) : null
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Scan phases" className="flex flex-col gap-1.5 text-sm">
        {SCAN_PHASES.map((phase) => {
          const state = lineState(phase, status)
          const Icon = ICON[state]
          return (
            <li
              key={phase}
              aria-current={state === 'active' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2',
                state === 'active' && 'text-accent-ink',
                (state === 'pending' || state === 'skipped') && 'text-muted-foreground',
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  'size-4 shrink-0',
                  state === 'active' && 'animate-spin motion-reduce:animate-none',
                  state === 'done' && 'text-success',
                )}
                stroke={1.75}
              />
              <span>
                {PHASE_LABEL[phase]}
                {state === 'active' && count ? `, ${count}` : ''}
                {state === 'skipped' ? ' (skipped)' : ''}
                <span className="sr-only">
                  {state === 'done' ? ', done' : state === 'pending' ? ', waiting' : ''}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
      <PhaseBar status={status} />
    </div>
  )
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
      className="h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={
          known
            ? 'h-full rounded-full bg-primary transition-[width] duration-500'
            : 'h-full w-1/3 animate-pulse rounded-full bg-primary/60 motion-reduce:animate-none'
        }
        style={
          known
            ? { width: `${Math.max(4, Math.round((status.done / status.total) * 100))}%` }
            : undefined
        }
      />
    </div>
  )
}
