import type { DeploymentItem } from '@hinomi/shared'
import type { ReactNode } from 'react'
import { IconAlertOctagon, IconEyeOff, IconLock, IconWorld } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import {
  deploymentFacts,
  HEAT_STEPS,
  SERVER_UNKNOWN,
  type DeploymentFacts,
  type ServerGroup,
} from '@/lib/deployment-map'
import { HEAT_FILL } from './deployment-map-meta'
import { displayDomain } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'

export function ReachIcon({ reach, className }: { reach: string; className?: string }) {
  const Cmp = reach === 'public' ? IconWorld : IconLock
  return (
    <Cmp
      aria-hidden="true"
      stroke={1.75}
      className={cn('size-[15px] shrink-0 text-muted-foreground', className)}
    />
  )
}

/** The legend of the map: the heat steps, then the blind spot hatch. */
export function HeatLegend({ className }: { className?: string }) {
  return (
    <ul
      aria-label="Map legend"
      className={cn(
        'm-0 flex list-none flex-wrap items-center gap-x-4 gap-y-2 p-0 text-xs text-foreground-2',
        className,
      )}
    >
      {HEAT_STEPS.map((step) => (
        <li key={step.level} className="flex items-center gap-2">
          <i
            aria-hidden="true"
            className={cn(
              'block h-3.5 w-[22px] rounded-[3px] border border-border',
              HEAT_FILL[step.level],
            )}
          />
          {step.label}
        </li>
      ))}
      <li className="flex items-center gap-2">
        <i
          aria-hidden="true"
          className="block h-3.5 w-[22px] rounded-[3px] border border-blind bg-[repeating-linear-gradient(135deg,var(--blind)_0_2px,transparent_2px_5px)]"
        />
        Blind spot
      </li>
    </ul>
  )
}

/** The big number on a tile and the words after it. */
function tileCount(d: DeploymentItem, f: DeploymentFacts): { value: ReactNode; label: string } {
  if (f.unmapped) {
    return { value: <span className="text-md text-blind">Unknown</span>, label: 'no repo mapped' }
  }
  if (f.imageOnly) {
    return { value: <span className="text-md">Image only</span>, label: 'no repo to scan' }
  }
  if (f.stopped) return { value: f.open, label: f.open ? 'findings, stopped' : 'stopped' }
  if (d.exposed > 0) return { value: d.exposed, label: 'exposed' }
  if (f.open > 0) return { value: f.open, label: 'findings, not exposed' }
  if (d.kind === 'database') return { value: 0, label: 'database, no repo needed' }
  return { value: 0, label: 'clean' }
}

function CriticalChip({ count }: { count: number }) {
  return (
    <Badge variant="critical-solid">
      <IconAlertOctagon aria-hidden="true" stroke={2} />
      {count} critical
    </Badge>
  )
}

/**
 * What one app on the map says: name, domain, the count, and its critical and blind spot marks.
 * The link around it gets `tileClass`.
 */
export function TileBody({ d }: { d: DeploymentItem }) {
  const f = deploymentFacts(d)
  const count = tileCount(d, f)
  const faded = f.stopped || f.imageOnly
  return (
    <>
      <span className="flex min-w-0 items-center gap-[7px] font-semibold text-foreground">
        <ReachIcon reach={d.reach} />
        <span className="truncate">{d.name}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {d.domains[0]
          ? displayDomain(d.domains[0])
          : d.reach === 'internal'
            ? 'Internal only'
            : 'No domain'}
      </span>
      <span className="mt-auto flex flex-wrap items-baseline gap-x-2">
        <b
          className={cn(
            'text-lg font-semibold tracking-[-0.02em] tabular-nums',
            faded ? 'text-foreground-2' : 'text-foreground',
          )}
        >
          {count.value}
        </b>
        <span className="text-xs text-foreground-2">{count.label}</span>
      </span>
      <span className="flex min-h-6 flex-wrap items-center gap-2">
        {d.openFindings.critical > 0 ? <CriticalChip count={d.openFindings.critical} /> : null}
        {f.blind ? (
          <Badge variant="blind">
            <IconEyeOff aria-hidden="true" stroke={2} />
            Blind spot
          </Badge>
        ) : null}
      </span>
    </>
  )
}

/** A server heading over its tiles or rows: mono name, then its role and app count. */
export function ServerHeading({
  group,
  as: As = 'h2',
}: {
  group: ServerGroup
  as?: 'h2' | 'span'
}) {
  return (
    <As className="flex items-baseline gap-2.5 text-xs font-normal text-muted-foreground">
      <b className="font-mono text-sm font-semibold text-foreground">
        {group.server ?? SERVER_UNKNOWN}
      </b>
      <span>
        {group.role}, {group.items.length} app{group.items.length === 1 ? '' : 's'}
      </span>
    </As>
  )
}

/** One app as a list row: the split list and the phone, where tiles become a list. */
export function DeploymentRow({ d }: { d: DeploymentItem }) {
  const f = deploymentFacts(d)
  let right: ReactNode
  if (f.unmapped) right = <span className="text-xs font-semibold text-blind">No repo</span>
  else if (f.imageOnly) right = <span className="text-xs text-muted-foreground">Image only</span>
  else if (f.stopped) right = <span className="text-xs text-muted-foreground">Stopped</span>
  else if (d.exposed > 0) {
    right = (
      <span className="text-xs text-muted-foreground">
        <b className="text-sm font-semibold text-accent-ink tabular-nums">{d.exposed}</b> exposed
      </span>
    )
  } else if (f.open > 0) {
    right = (
      <span className="text-xs text-muted-foreground tabular-nums">
        {f.open} {d.reach === 'public' ? 'open' : 'internal'}
      </span>
    )
  } else right = <span className="text-xs text-muted-foreground">Clean</span>
  return (
    <span
      className={cn(
        'grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1',
        (f.stopped || f.imageOnly) && 'opacity-75',
      )}
    >
      <ReachIcon reach={d.reach} className="size-4" />
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-semibold text-foreground">{d.name}</span>
        {f.blind ? (
          <IconEyeOff
            aria-label="Blind spot"
            role="img"
            stroke={2}
            className="size-4 shrink-0 text-blind"
          />
        ) : null}
        {d.openFindings.critical > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-sev-critical">
            <IconAlertOctagon aria-hidden="true" stroke={2} className="size-3.5" />
            {d.openFindings.critical}
            <span className="sr-only"> critical</span>
          </span>
        ) : null}
      </span>
      {right}
      <span className="col-start-2 col-end-4 truncate text-xs text-muted-foreground">
        {d.domains[0]
          ? displayDomain(d.domains[0])
          : d.reach === 'internal'
            ? 'Internal only'
            : 'No domain'}
      </span>
    </span>
  )
}
