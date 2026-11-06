import type { DeploymentItem } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import {
  IconCircleCheck,
  IconCircleX,
  IconEyeOff,
  IconHelpCircle,
  IconLock,
  IconWorld,
} from '@tabler/icons-react'
import { StatusText } from '@/components/findings/finding-state'
import { Badge } from '@/components/ui/badge'
import { deploymentStatus, repoLabel } from '@/lib/finding-meta'
import { cn } from '@/lib/utils'

export function ReachBadge({ reach }: { reach: DeploymentItem['reach'] }) {
  if (reach === 'public') {
    return (
      <Badge variant="accent">
        <IconWorld aria-hidden="true" />
        Public
      </Badge>
    )
  }
  if (reach === 'internal') {
    return (
      <Badge variant="outline">
        <IconLock aria-hidden="true" />
        Internal
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <IconHelpCircle aria-hidden="true" />
      Unknown
    </Badge>
  )
}

export function RunStatus({ status }: { status: string | null }) {
  const s = deploymentStatus(status)
  return (
    <StatusText
      icon={s.tone === 'ok' ? IconCircleCheck : s.tone === 'off' ? IconCircleX : IconHelpCircle}
      tone={s.tone === 'ok' ? 'ok' : 'neutral'}
      title={status ?? undefined}
    >
      {s.label}
    </StatusText>
  )
}

/** Whether Dependabot alerts cover the deployment's repos, as a table cell. */
export function CoverageCell({ d }: { d: DeploymentItem }) {
  if (d.coverage.alerts === 'disabled') {
    return (
      <Badge
        variant="high"
        title="GitHub alerts are off for this repo. Counts come from the OSV lockfile scan."
      >
        <IconEyeOff aria-hidden="true" />
        Alerts off
      </Badge>
    )
  }
  if (d.coverage.alerts === 'none') {
    return (
      <span className="text-sm text-muted-foreground">
        {d.kind === 'database' ? 'Not needed' : 'No repo'}
      </span>
    )
  }
  if (d.coverage.alerts === 'unknown')
    return <span className="text-sm text-muted-foreground">Unknown</span>
  return d.coverage.covered ? (
    <StatusText icon={IconCircleCheck} tone="ok">
      Covered
    </StatusText>
  ) : (
    <StatusText icon={IconEyeOff} tone="bad">
      {d.coverage.blindSpots.length} blind spot{d.coverage.blindSpots.length === 1 ? '' : 's'}
    </StatusText>
  )
}

const MAPPING_LABEL: Record<DeploymentItem['mapping'], string> = {
  auto: '(matched from Coolify)',
  override: '(manual mapping)',
  none: '',
}

/**
 * The join made visible: the app, the git source it maps to, the open alerts there, and what
 * of it matters. Four nodes in a row, stacked on a phone.
 */
export function JoinStrip({
  d,
  exposed,
  className,
}: {
  d: DeploymentItem
  exposed: number
  className?: string
}) {
  const repo = repoLabel(d)
  const open =
    d.openFindings.critical + d.openFindings.high + d.openFindings.moderate + d.openFindings.low
  const nodes: { label: string; value: React.ReactNode; sub: React.ReactNode; hot?: boolean }[] = [
    {
      label: `${d.source.kind === 'coolify' ? 'Coolify' : d.source.name} ${d.kind}`,
      value: d.name,
      sub:
        [d.server, d.image ? `image ${d.image}` : null].filter(Boolean).join(', ') ||
        'No server reported',
    },
    {
      label: `Git source ${MAPPING_LABEL[d.mapping]}`,
      value: (
        <span className="font-mono">
          {repo ? `${repo}${d.gitBranch ? `@${d.gitBranch}` : ''}` : 'None'}
        </span>
      ),
      sub: repo
        ? d.coverage.alerts === 'disabled'
          ? 'GitHub alerts off, OSV lockfile scan on'
          : 'GitHub alerts and OSV lockfile scan'
        : d.kind === 'database'
          ? 'Databases need no repo'
          : 'Registry image, no source',
    },
    {
      label: 'Open alerts',
      value: repo ? `${open} on this app` : 'Cannot match',
      sub: repo ? 'Runtime and dev, all severities' : 'Map a repo to see findings',
    },
    {
      label: 'What matters',
      value: exposed
        ? `${exposed} exposed or blind spot${exposed === 1 ? '' : 's'}`
        : repo || d.kind === 'database'
          ? 'Nothing exposed'
          : 'Unknown',
      sub: exposed
        ? 'Ranked at the top of Exposure'
        : d.reach === 'public'
          ? 'No critical or high in runtime code'
          : 'Internal app, tier 2 or lower',
      hot: exposed > 0,
    },
  ]
  return (
    <ol
      aria-label="How this deployment joins its repo and alerts"
      className={cn('m-0 grid list-none gap-1.5 p-0 tab:grid-cols-4 tab:gap-0', className)}
    >
      {nodes.map((n, i) => (
        <li
          key={n.label}
          className={cn(
            'flex min-w-0 items-center',
            i > 0 &&
              "tab:before:block tab:before:h-px tab:before:w-3.5 tab:before:flex-none tab:before:bg-input tab:before:content-['']",
          )}
        >
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border bg-card px-3.5 py-2.5',
              n.hot ? 'border-sev-critical' : 'border-border',
            )}
          >
            <small className="text-xs text-muted-foreground">{n.label}</small>
            <b className="truncate font-medium">{n.value}</b>
            <small className="truncate text-xs text-muted-foreground">{n.sub}</small>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function AppLink({
  d,
  className,
}: {
  d: Pick<DeploymentItem, 'id' | 'name'>
  className?: string
}) {
  return (
    <Link
      to="/deployments/$id"
      params={{ id: String(d.id) }}
      data-row-link
      className={cn('font-medium text-foreground hover:text-accent-ink', className)}
    >
      {d.name}
    </Link>
  )
}
