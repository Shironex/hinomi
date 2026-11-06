import type { DeploymentDetail } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronRight,
  IconEyeOff,
  IconPlugConnected,
  IconServerOff,
  IconShieldCheck,
} from '@tabler/icons-react'
import { FindingRow } from '@/components/findings/finding-row'
import { SeverityBadge } from '@/components/findings/severity-badge'
import { SEVERITY_FILL } from '@/lib/view-icons'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { JoinStrip, ReachBadge, RunStatus } from '@/components/views/deployment-bits'
import { DeploysPanel } from '@/components/views/deploys-panel'
import { KeyValues, Panel, PanelBody, PanelHeader, Section } from '@/components/views/panel'
import { RepoMappingPanel } from '@/components/views/repo-mapping'
import { ApiError } from '@/lib/api'
import {
  BLIND_SPOT_INFO,
  displayDomain,
  domainHref,
  formatDate,
  SEVERITIES,
} from '@/lib/finding-meta'
import { MAPPING_SETTINGS, needsRepo } from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { deploymentQuery } from '@/lib/view-api'

const route = getRouteApi('/deployments/$id')

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
                <span
                  className={d.coverage.alerts === 'disabled' ? 'text-sev-critical' : undefined}
                >
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

export function DeploymentDetailPage() {
  const { id: raw } = route.useParams()
  const id = Number(raw)
  const valid = Number.isInteger(id) && id > 0
  const query = useQuery({ ...deploymentQuery(valid ? id : 0), enabled: valid })

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <>
        <PageHeader title={<span className="font-mono text-[0.92em]">{raw}</span>} />
        <EmptyState
          icon={IconServerOff}
          title="This deployment is not known yet"
          actions={
            <Button asChild variant="outline">
              <Link to="/deployments">
                <IconArrowLeft aria-hidden="true" />
                All deployments
              </Link>
            </Button>
          }
        >
          Deployments appear after Coolify is connected and scanned. Apps removed from Coolify drop
          out on the next scan.
        </EmptyState>
      </>
    )
  }
  if (query.error) {
    return (
      <>
        <PageHeader title={`Deployment ${raw}`} />
        <ErrorState
          title="This deployment did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </>
    )
  }
  if (!query.data) return <LoadingState layout="detail" label="Loading deployment" />

  const d = query.data
  const top = d.findings.filter((f) => f.tier === 'exposed' || f.tier === 'blind_spot')
  const blind = d.findings.filter((f) => f.kind === 'blind_spot')
  const repoNames = d.repos.map((r) => r.fullName).join(', ')

  return (
    <>
      <div className="mb-6 flex flex-col gap-2.5 border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <ReachBadge reach={d.reach} />
          <RunStatus status={d.status} />
          {d.server ? <span className="font-mono">{d.server}</span> : null}
          {d.coverage.alerts === 'disabled' ? (
            <Badge variant="high">
              <IconEyeOff aria-hidden="true" />
              GitHub alerts off
            </Badge>
          ) : null}
        </div>
        <h1 className="text-lg">{d.name}</h1>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
          {d.domains.length ? (
            d.domains.map((x) => (
              <a
                key={x}
                href={domainHref(x)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-ink hover:underline"
              >
                {displayDomain(x)}
              </a>
            ))
          ) : (
            <span>No domain</span>
          )}
          {d.lastDeployedAt ? <span>Deployed {formatRelative(d.lastDeployedAt)}</span> : null}
        </div>
      </div>

      <JoinStrip d={d} exposed={top.length} className="mb-6" />

      <div className="grid items-start gap-7 desk:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          {needsRepo(d) ? (
            <Callout variant="warn" icon={IconPlugConnected} title="No repo matched">
              This app runs <span className="font-mono">{d.image ?? 'an image'}</span> with no git
              source in Coolify. Map the repo it is built from in{' '}
              <Link {...MAPPING_SETTINGS} className="font-medium text-accent-ink hover:underline">
                Settings, Repo mapping
              </Link>{' '}
              so its alerts and lockfile count.
            </Callout>
          ) : null}
          {blind.map((b) => (
            <Link
              key={b.id}
              to="/finding/$id"
              params={{ id: String(b.id) }}
              className="flex items-start gap-3 rounded-lg border border-sev-critical bg-card px-3.5 py-3 text-sm text-inherit no-underline hover:bg-sidebar"
            >
              <IconEyeOff
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-sev-critical"
                stroke={1.75}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <b className="font-semibold">
                  Blind spot:{' '}
                  {b.blindSpotType ? BLIND_SPOT_INFO[b.blindSpotType].title : 'Coverage missing'}
                </b>
                <span className="text-muted-foreground">
                  {b.blindSpotType ? BLIND_SPOT_INFO[b.blindSpotType].explain : null}
                </span>
              </span>
              <IconChevronRight
                aria-hidden="true"
                className="ml-auto size-4 shrink-0 self-center text-muted-foreground"
              />
            </Link>
          ))}

          <Section
            title="Exposed findings"
            description={top.length ? `${top.length} on this app` : 'None'}
            titleId="dep-exposed"
          >
            {top.length ? (
              <div
                data-list
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

          {d.repos.length ? (
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
          ) : null}

          {d.kind !== 'database' ? <RepoMappingPanel d={d} /> : null}
        </div>
        <div className="flex flex-col gap-4">
          <Join d={d} />
          {d.kind === 'application' ? <DeploysPanel d={d} /> : null}
          <Coverage d={d} />
        </div>
      </div>
    </>
  )
}
