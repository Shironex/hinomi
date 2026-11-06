import type { DeploymentItem, FindingTier } from '@hinomi/shared'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconArchive,
  IconArrowRight,
  IconChevronDown,
  IconPlugConnected,
  IconServer2,
} from '@tabler/icons-react'
import { SeverityCounts } from '@/components/findings/severity-badge'
import { StatusText } from '@/components/findings/finding-state'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AppLink,
  CoverageCell,
  JoinStrip,
  ReachBadge,
  RunStatus,
} from '@/components/views/deployment-bits'
import { ScanStrip } from '@/components/views/scan-strip'
import { displayDomain } from '@/lib/finding-meta'
import { needsRepo } from '@/lib/finding-meta'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { deploymentsQuery, findingsQuery, reposQuery } from '@/lib/view-api'

/** Same query as the overview list, so the cache is shared. */
const TOP_PARAMS = { tier: ['blind_spot', 'exposed'] as FindingTier[], limit: 100 }

const TD = 'border-t border-border px-3 py-2.5 align-middle max-tab:border-0 max-tab:p-0'
const HIDE_CARD = 'max-tab:hidden'
const HIDE_MID = 'tab:max-desk:hidden'

function Row({
  d,
  exposed,
  open,
  onToggle,
}: {
  d: DeploymentItem
  exposed: number
  open: boolean
  onToggle: () => void
}) {
  const repo = d.repos[0]
  return (
    <>
      <tr
        data-row
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a, button')) return
          onToggle()
        }}
        className={cn(
          'cursor-pointer hover:bg-sidebar max-tab:grid max-tab:grid-cols-[minmax(0,1fr)_auto] max-tab:gap-x-2.5 max-tab:gap-y-1.5 max-tab:border-t max-tab:border-border max-tab:p-3',
          open && 'bg-sidebar',
        )}
      >
        <td className={cn(TD, 'max-tab:col-span-2')}>
          <span className="flex min-w-0 flex-col gap-0.5">
            <b className="font-medium">
              <AppLink d={d} />
            </b>
            <small className="text-xs text-muted-foreground">
              {d.domains.length
                ? d.domains.map(displayDomain).join(', ')
                : d.kind === 'database'
                  ? 'Database, no domain'
                  : 'No domain'}
            </small>
          </span>
        </td>
        <td className={TD}>
          <ReachBadge reach={d.reach} />
        </td>
        <td className={cn(TD, HIDE_CARD, 'text-sm')}>
          {repo ? (
            <>
              <span className="font-mono text-[12.5px]">{repo.fullName}</span>
              {d.repos.length > 1 ? (
                <span className="text-muted-foreground"> +{d.repos.length - 1}</span>
              ) : null}
              {d.gitBranch ? (
                <span className="font-mono text-xs text-muted-foreground"> @{d.gitBranch}</span>
              ) : null}
            </>
          ) : needsRepo(d) ? (
            <StatusText icon={IconPlugConnected} tone="wait">
              No repo matched
            </StatusText>
          ) : (
            <span className="text-muted-foreground">Not needed</span>
          )}
        </td>
        <td className={cn(TD, HIDE_CARD, HIDE_MID, 'font-mono text-[12.5px] whitespace-nowrap')}>
          {d.server ?? 'Unknown'}
        </td>
        <td className={cn(TD, HIDE_CARD)}>
          <RunStatus status={d.status} />
        </td>
        <td
          className={cn(TD, HIDE_CARD, HIDE_MID, 'text-sm whitespace-nowrap text-muted-foreground')}
        >
          {d.lastDeployedAt ? formatRelative(d.lastDeployedAt) : 'Unknown'}
        </td>
        <td className={TD}>
          <CoverageCell d={d} />
        </td>
        <td className={cn(TD, 'max-tab:col-span-2')}>
          <span className="flex flex-wrap items-center gap-1.5">
            {exposed ? <Badge variant="critical">{exposed} exposed</Badge> : null}
            <SeverityCounts
              counts={d.openFindings}
              empty={d.repos.length ? 'None open' : 'Unknown'}
            />
          </span>
        </td>
        <td className={cn(TD, 'w-10 max-tab:hidden')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the join for ${d.name}`}
            onClick={onToggle}
          >
            <IconChevronDown
              aria-hidden="true"
              className={cn('transition-transform', open && 'rotate-180')}
            />
          </Button>
        </td>
      </tr>
      {open ? (
        <tr className="max-tab:block">
          <td colSpan={9} className="border-t border-border bg-sidebar p-3 max-tab:block">
            <JoinStrip d={d} exposed={exposed} />
            <div className="mt-2.5">
              <Button asChild size="sm" variant="outline">
                <Link to="/deployments/$id" params={{ id: String(d.id) }}>
                  Open {d.name}
                  <IconArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

export function DeploymentsPage() {
  const query = useQuery(deploymentsQuery)
  const top = useQuery(findingsQuery(TOP_PARAMS))
  const repos = useQuery(reposQuery)
  const [expanded, setExpanded] = useState<number | null>(null)

  const exposedBy = useMemo(() => {
    const map = new Map<number, number>()
    for (const f of top.data?.items ?? []) {
      if (f.state === 'fixed') continue
      for (const d of f.deployments) map.set(d.id, (map.get(d.id) ?? 0) + 1)
    }
    return map
  }, [top.data])

  const header = (
    <PageHeader title="Deployments">
      {query.data?.items.length
        ? `${query.data.items.length} apps, joined to their GitHub repos. Select a row for a quick look at the join, or the app name for its page.`
        : 'Every running app with its domains, server and repo, and what is exposed on it.'}
    </PageHeader>
  )

  if (query.error) {
    return (
      <>
        {header}
        <ErrorState
          title="Deployments did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </>
    )
  }
  if (!query.data) return <LoadingState layout="table" label="Loading deployments" />

  const items = query.data.items
  if (items.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={IconServer2}
          title="No deployments yet"
          actions={
            <Button asChild variant="outline">
              <Link to="/onboarding">Connect Coolify</Link>
            </Button>
          }
        >
          Hinomi reads applications, services and servers from Coolify with a read only token, then
          maps each one to its GitHub repo.
        </EmptyState>
      </>
    )
  }

  const mapped = new Set(items.flatMap((d) => d.repos.map((r) => r.id)))
  const unmapped = (repos.data?.items ?? []).filter((r) => !mapped.has(r.id))

  return (
    <>
      {header}
      <ScanStrip />
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table data-list className="w-full border-collapse text-sm max-tab:block">
          <caption className="sr-only">
            Deployments with their repo, coverage and open findings
          </caption>
          <thead className="max-tab:hidden">
            <tr className="bg-sidebar text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">
                App
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Exposure
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Repo
              </th>
              <th scope="col" className={cn('px-3 py-2 font-medium', HIDE_MID)}>
                Server
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className={cn('px-3 py-2 font-medium', HIDE_MID)}>
                Last deploy
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Alerts
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Critical, high, moderate, low
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">Join</span>
              </th>
            </tr>
          </thead>
          <tbody className="max-tab:block">
            {items.map((d) => (
              <Row
                key={d.id}
                d={d}
                exposed={exposedBy.get(d.id) ?? 0}
                open={expanded === d.id}
                onToggle={() => setExpanded((cur) => (cur === d.id ? null : d.id))}
              />
            ))}
          </tbody>
        </table>
      </div>
      {unmapped.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-start gap-3 rounded-lg border border-border bg-sidebar px-3.5 py-3 text-sm">
          <IconArchive
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-foreground-2"
            stroke={1.75}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <b className="font-semibold">
              {unmapped.length} repo{unmapped.length === 1 ? ' has' : 's have'} no deployment
            </b>
            <span className="text-muted-foreground">
              Their alerts rank last in All alerts. If one of them runs somewhere, map it on that
              deployment&apos;s page.
            </span>
          </span>
          <Button asChild size="sm" variant="outline">
            <Link to="/alerts" search={{ tier: ['not_deployed'] }}>
              View
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  )
}
