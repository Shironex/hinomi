import type { DeploymentDetail } from '@hinomi/shared'
import { Link } from '@tanstack/react-router'
import {
  IconArrowRight,
  IconBox,
  IconBrandGithub,
  IconChevronRight,
  IconEyeOff,
  IconGitBranch,
  IconPlugConnected,
  IconServer2,
  IconShieldCheck,
  IconWorld,
} from '@tabler/icons-react'
import { FindingRow } from '@/components/findings/finding-row'
import { SeverityBadge } from '@/components/findings/severity-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { JoinStrip, ReachBadge, RunStatus } from '@/components/views/deployment-bits'
import { DeploysPanel } from '@/components/views/deploys-panel'
import { KeyValues, Panel, PanelBody, PanelHeader, Section } from '@/components/views/panel'
import { RepoMappingPanel } from '@/components/views/repo-mapping'
import { bumpsThatClear } from '@/lib/deployment-map'
import {
  BLIND_SPOT_INFO,
  COVERAGE_NOTE_INFO,
  displayDomain,
  domainHref,
  formatDate,
  MAPPING_SETTINGS,
  needsRepo,
  SEVERITIES,
} from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SEVERITY_FILL } from '@/lib/view-icons'

function SeverityBars({ d }: { d: DeploymentDetail }) {
  const c = d.openFindings
  const total = c.critical + c.high + c.moderate + c.low
  if (total === 0) return <span className="text-sm text-muted-foreground">None open</span>
  return (
    <div className="flex flex-col gap-2">
      {SEVERITIES.filter((k) => c[k] > 0).map((k) => (
        <div
          key={k}
          className="grid grid-cols-[110px_minmax(0,1fr)_40px] items-center gap-3 text-sm"
        >
          <span>
            <SeverityBadge severity={k} />
          </span>
          <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-[3px] bg-muted">
            <span
              className={`block h-full rounded-[3px] ${SEVERITY_FILL[k]}`}
              style={{ width: `${Math.max(4, (c[k] / total) * 100)}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{c[k]}</span>
        </div>
      ))}
    </div>
  )
}

function Coverage({ d }: { d: DeploymentDetail }) {
  const alerts = {
    enabled: 'On',
    disabled: 'Off',
    unknown: 'Unknown',
    none: 'Not available',
  }[d.coverage.alerts]
  return (
    <Panel>
      <PanelHeader title="Coverage" />
      <PanelBody>
        <KeyValues
          items={[
            {
              label: 'GitHub alerts',
              value: (
                <span className={d.coverage.alerts === 'disabled' ? 'text-sev-high' : undefined}>
                  {alerts}
                </span>
              ),
            },
            {
              label: 'OSV lockfile',
              value:
                d.repos.length === 0
                  ? 'Not available'
                  : d.coverage.blindSpots.includes('lockfile_missing')
                    ? 'No lockfile committed'
                    : d.coverage.blindSpots.includes('lockfile_unparseable')
                      ? 'Lockfile unreadable'
                      : 'On',
            },
            ...(d.coverage.imageOnly ? [{ label: 'Image scan', value: 'Phase 2 (not yet)' }] : []),
            {
              label: 'Blind spots',
              value: d.coverage.blindSpots.length
                ? d.coverage.blindSpots.map((b) => BLIND_SPOT_INFO[b].short).join(', ')
                : 'None',
            },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}

function Join({ d }: { d: DeploymentDetail }) {
  return (
    <Panel>
      <PanelHeader title="Join" />
      <PanelBody>
        <KeyValues
          items={[
            { label: 'Source', value: `${d.source.name} (${d.source.kind})` },
            { label: 'Kind', value: d.kind },
            { label: 'Server', value: d.server ?? 'Unknown', mono: true },
            { label: 'Image', value: d.image ?? 'None', mono: true },
            {
              label: 'Repo',
              value: d.repos.map((r) => r.fullName).join(', ') || 'None',
              mono: true,
            },
            { label: 'Branch', value: d.gitBranch ?? 'None', mono: true },
            {
              label: 'Mapping',
              value: { auto: 'From Coolify', override: 'Manual', none: 'Missing' }[d.mapping],
            },
            {
              label: 'Watch paths',
              value: d.watchPaths?.length ? d.watchPaths.join(', ') : 'None',
              mono: true,
            },
            { label: 'First seen', value: formatDate(d.firstSeenAt) },
          ]}
        />
      </PanelBody>
    </Panel>
  )
}

/** Exposed, critical, high and blind spots in four cells, like the design's number row. */
function Numbers({ d }: { d: DeploymentDetail }) {
  const cells = [
    { label: 'Exposed', value: d.exposed },
    { label: 'Critical', value: d.openFindings.critical },
    { label: 'High', value: d.openFindings.high },
    { label: 'Blind spots', value: d.openBlindSpots },
  ]
  return (
    <dl className="m-0 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card tab:grid-cols-4">
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={cn(
            'flex flex-col gap-1 border-border px-4 py-3.5',
            i % 2 === 1 && 'border-l',
            i >= 2 && 'max-tab:border-t',
            i >= 1 && 'tab:border-l',
          )}
        >
          <dt className="text-xs text-muted-foreground">{c.label}</dt>
          <dd
            className={cn(
              'm-0 text-lg font-semibold tabular-nums',
              c.label === 'Blind spots' && c.value > 0 && 'text-blind',
            )}
          >
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The bumps that clear the most exposed findings on this app, worked out from its findings. */
function Bumps({ d }: { d: DeploymentDetail }) {
  const bumps = bumpsThatClear(d.findings).slice(0, 3)
  if (bumps.length === 0) return null
  return (
    <section
      aria-labelledby="dep-bumps"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 pt-[18px] pb-2"
    >
      <h2 id="dep-bumps" className="text-md">
        Bumps that clear the most here
      </h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {bumps.map((b) => (
          <li
            key={b.packageName}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 border-t border-border py-3 first:border-t-0 first:pt-1"
          >
            <span className="min-w-0 truncate font-mono text-sm text-foreground">
              {b.packageName}{' '}
              {b.to ? (
                <>
                  <span aria-hidden="true">&#8594;</span>
                  <span className="sr-only">to</span>{' '}
                  <b className="font-medium text-success">{b.to}</b>
                </>
              ) : (
                <span className="font-sans text-muted-foreground">no patch yet</span>
              )}
            </span>
            <span className="text-md font-semibold text-accent-ink tabular-nums">
              {b.to ? b.clears : b.waiting}
            </span>
            <small className="col-span-2 text-xs text-muted-foreground">
              {b.to
                ? `finding${b.clears === 1 ? '' : 's'} cleared${b.waiting ? `, ${b.waiting} still waiting on a patch` : ''}`
                : `finding${b.waiting === 1 ? '' : 's'} waiting on a patch`}
            </small>
          </li>
        ))}
      </ul>
    </section>
  )
}

export interface DeploymentDetailViewProps {
  d: DeploymentDetail
  /** Two columns (focus view and the deployment page) or one stack (beside the split list). */
  layout: 'stack' | 'two'
  /** The deployment page owns the h1; in the split view the list header does. */
  titleLevel: 1 | 2
}

/**
 * Everything about one deployment: its join, what is exposed on it, blind spots, the bumps that
 * clear the most, recent deploys and how its repo is mapped (read only, edited in Settings).
 */
export function DeploymentDetailView({ d, layout, titleLevel }: DeploymentDetailViewProps) {
  const top = d.findings.filter((f) => f.tier === 'exposed' || f.tier === 'blind_spot')
  const blind = d.findings.filter((f) => f.kind === 'blind_spot')
  const repoNames = d.repos.map((r) => r.fullName).join(', ')
  const Title = titleLevel === 1 ? 'h1' : 'h2'

  const head = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {d.server ? (
          <Badge variant="default" className="font-mono font-medium">
            <IconServer2 aria-hidden="true" />
            {d.server}
          </Badge>
        ) : null}
        <RunStatus status={d.status} />
        <ReachBadge reach={d.reach} />
        {d.coverage.alerts === 'disabled' ? (
          <Badge variant="high">
            <IconEyeOff aria-hidden="true" />
            GitHub alerts off
          </Badge>
        ) : null}
        {d.lastDeployedAt ? (
          <span>
            Deployed {formatRelative(d.lastDeployedAt)}
            {d.gitBranch ? ` from ${d.gitBranch}` : ''}
          </span>
        ) : null}
      </div>
      <Title className="text-xl font-semibold tracking-[-0.02em] break-words">{d.name}</Title>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-foreground-2">
        {d.domains.length ? (
          d.domains.map((x) => (
            <span key={x} className="inline-flex items-center gap-1.5">
              <IconWorld aria-hidden="true" className="size-[15px]" stroke={1.75} />
              <a
                href={domainHref(x)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-ink hover:underline"
              >
                {displayDomain(x)}
              </a>
            </span>
          ))
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <IconWorld aria-hidden="true" className="size-[15px]" stroke={1.75} />
            No domain
          </span>
        )}
        {d.repos.map((r) => (
          <span key={r.id} className="inline-flex items-center gap-1.5">
            <IconBrandGithub aria-hidden="true" className="size-[15px]" stroke={1.75} />
            <span className="font-mono text-sm">{r.fullName}</span>
          </span>
        ))}
        {d.gitBranch ? (
          <span className="inline-flex items-center gap-1.5">
            <IconGitBranch aria-hidden="true" className="size-[15px]" stroke={1.75} />
            <span className="font-mono text-sm">{d.gitBranch}</span>
          </span>
        ) : null}
      </div>
    </div>
  )

  const notes = (
    <>
      {needsRepo(d) ? (
        <Callout variant="warn" icon={IconPlugConnected} title="No repo matched">
          This app is built from{' '}
          <span className="font-mono">{d.gitRepository ?? 'a git source'}</span>, which Hinomi could
          not match to a GitHub repo. Map the repo it is built from in{' '}
          <Link {...MAPPING_SETTINGS} className="font-medium text-accent-ink hover:underline">
            Settings, Repo mapping
          </Link>{' '}
          so its alerts and lockfile count.
        </Callout>
      ) : null}
      {d.coverage.imageOnly ? (
        <Callout variant="default" icon={IconBox} title={COVERAGE_NOTE_INFO.image_only.title}>
          It runs <span className="font-mono">{d.image ?? 'a container image'}</span>.{' '}
          {COVERAGE_NOTE_INFO.image_only.explain}
        </Callout>
      ) : null}
      {blind.length ? (
        <ul aria-label="Blind spots" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {blind.map((b) => (
            <li key={b.id}>
              <Link
                to="/finding/$id"
                params={{ id: String(b.id) }}
                className="flex items-start gap-3 rounded-lg border border-[color-mix(in_oklab,var(--blind)_55%,var(--border))] bg-(image:--blind-hatch) px-3.5 py-3 text-sm text-inherit no-underline hover:brightness-110"
              >
                <IconEyeOff
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-blind"
                  stroke={1.75}
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <b className="font-semibold text-foreground">
                    Blind spot:{' '}
                    {b.blindSpotType ? BLIND_SPOT_INFO[b.blindSpotType].title : 'Coverage missing'}
                  </b>
                  <span className="text-foreground-2">
                    {b.blindSpotType ? BLIND_SPOT_INFO[b.blindSpotType].explain : null}
                  </span>
                </span>
                <IconChevronRight
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 self-center text-muted-foreground"
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )

  const exposed = (
    <Section
      title="Exposed findings in this app"
      description={top.length ? `${top.length}, ranked` : 'None'}
      titleId="dep-exposed"
    >
      {top.length ? (
        <div
          aria-labelledby="dep-exposed"
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          {top.map((f, i) => (
            <FindingRow key={f.id} item={f} rank={i + 1} />
          ))}
        </div>
      ) : (
        <Callout
          icon={IconShieldCheck}
          title={
            d.repos.length || d.kind === 'database'
              ? 'Nothing exposed on this app'
              : 'Unknown until a repo is mapped'
          }
        >
          {d.repos.length || d.kind === 'database'
            ? d.reach === 'public'
              ? 'No critical or high advisory in its runtime dependencies.'
              : 'It has no public domain, so its alerts rank in tier 2 or lower.'
            : 'Hinomi cannot read alerts or a lockfile without a git source.'}
        </Callout>
      )}
    </Section>
  )

  const alerts = d.repos.length ? (
    <Section
      title={`Open alerts in ${repoNames}`}
      description="All severities, runtime and dev"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/alerts" search={{ deployment: [d.id] }}>
            See in All alerts
            <IconArrowRight aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      <Panel className="p-4">
        <SeverityBars d={d} />
      </Panel>
    </Section>
  ) : null

  const deploys = d.kind === 'application' ? <DeploysPanel d={d} /> : null
  const mapping = d.kind !== 'database' ? <RepoMappingPanel d={d} /> : null

  if (layout === 'two') {
    return (
      <>
        {head}
        <Numbers d={d} />
        <JoinStrip d={d} exposed={top.length} />
        <div className="grid items-start gap-8 desk:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            {notes}
            {exposed}
            {alerts}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Bumps d={d} />
            {deploys}
            {mapping}
            <Join d={d} />
            <Coverage d={d} />
          </div>
        </div>
      </>
    )
  }
  return (
    <>
      {head}
      <Numbers d={d} />
      <JoinStrip d={d} exposed={top.length} columns={2} />
      {notes}
      <Bumps d={d} />
      {exposed}
      {alerts}
      <div className="grid items-start gap-4 desk:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {deploys}
          <Join d={d} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {mapping}
          <Coverage d={d} />
        </div>
      </div>
    </>
  )
}
