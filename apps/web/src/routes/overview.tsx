import type { FindingListItem, FindingTier, OverviewResponse, SeverityCounts } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  IconArchive,
  IconChevronRight,
  IconPlugConnected,
  IconRadar2,
  IconShieldCheck,
} from '@tabler/icons-react'
import { FindingRow } from '@/components/findings/finding-row'
import { FactorLegend, RankMarker } from '@/components/findings/rank-marker'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { ActivityPanel } from '@/components/views/activity-feed'
import { ExposureFunnel } from '@/components/views/exposure-funnel'
import { Section, Term } from '@/components/views/panel'
import { ScanStrip } from '@/components/views/scan-strip'
import { SourceHealthPanel } from '@/components/views/source-health'
import { isDecided, SEVERITY_LABEL, TERMS, TIER_INFO } from '@/lib/finding-meta'
import { findingsQuery, overviewQuery } from '@/lib/view-api'

const number = new Intl.NumberFormat('en-US')

/** Blind spots and exposed findings, the spine of the page. */
const TOP_PARAMS = { tier: ['blind_spot', 'exposed'] as FindingTier[], limit: 100 }

const LEDE_LINK = 'text-accent-ink hover:underline'

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div aria-hidden="true" className="flex flex-col gap-2.5">
        <Skeleton className="h-[26px] w-[340px]" />
        <Skeleton className="h-3 w-[520px]" />
      </div>
      <div
        aria-hidden="true"
        className="grid grid-cols-5 overflow-hidden rounded-lg border border-border bg-card"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 border-border p-4 not-last:border-r">
            <Skeleton className="h-6 w-[70%] max-w-[70px]" />
            <Skeleton className="h-2.5 w-[80%]" />
            <Skeleton className="h-2 w-1/2" />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="mt-2 grid items-start gap-6 desk:grid-cols-[minmax(0,1fr)_320px]"
      >
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-border px-4 py-3.5 first:border-t-0 tab:grid-cols-[28px_46px_minmax(0,1fr)_auto]"
            >
              <span className="hidden tab:block" />
              <Skeleton className="hidden h-3.5 w-[46px] tab:block" />
              <span className="flex flex-col gap-[7px]">
                <Skeleton className="h-3.5 w-[200px]" />
                <Skeleton className="h-3 w-[70%]" />
                <Skeleton className="h-2.5 w-[45%]" />
              </span>
              <Skeleton className="h-[26px] w-24" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[120px] w-full rounded-lg" />
          <Skeleton className="h-[180px] w-full rounded-lg" />
        </div>
      </div>
      <p role="status" className="sr-only">
        Loading exposure
      </p>
    </div>
  )
}

function Heading({ overview }: { overview: OverviewResponse }) {
  const { exposed, needsAction } = overview.funnel
  if (exposed === 0) return <>Nothing is exposed right now</>
  return (
    <>
      <Term definition={TERMS.exposed}>{number.format(exposed)} exposed</Term>,{' '}
      <Term definition={TERMS.needsAction}>
        {number.format(needsAction)} need{needsAction === 1 ? 's' : ''} action
      </Term>
    </>
  )
}

function Lede({ overview }: { overview: OverviewResponse }) {
  const blind = overview.blindSpots.total
  return (
    <>
      Critical or high advisories in runtime code on apps with a public domain.
      {blind > 0 ? (
        <>
          {' '}
          Plus{' '}
          <Term definition={TERMS.blindSpot}>
            {blind} blind spot{blind === 1 ? '' : 's'}
          </Term>
          : deployed code Hinomi cannot fully see into.
        </>
      ) : null}{' '}
      Everything else is ranked below and listed under{' '}
      <Link to="/alerts" className={LEDE_LINK}>
        All alerts
      </Link>
      .
    </>
  )
}

/** Needs action first, decided rows after them, each group in rank order. */
function ordered(items: readonly FindingListItem[]): FindingListItem[] {
  return [...items.filter((i) => !isDecided(i.state)), ...items.filter((i) => isDecided(i.state))]
}

const BELOW: { tier: FindingTier; flags: readonly boolean[] }[] = [
  { tier: 'internal', flags: [false, true, true, false] },
  { tier: 'public_low', flags: [false, true, true, true] },
  { tier: 'dev', flags: [false, false, true, false] },
]

const MIX: { key: keyof SeverityCounts; color: string }[] = [
  { key: 'critical', color: 'bg-sev-critical' },
  { key: 'high', color: 'bg-sev-high' },
  { key: 'moderate', color: 'bg-sev-moderate' },
  { key: 'low', color: 'bg-sev-low' },
]

/** The severity mix of a tier as one thin bar, with the counts for screen readers. */
export function SeverityMix({ counts }: { counts: SeverityCounts | undefined }) {
  if (!counts) return null
  const total = counts.critical + counts.high + counts.moderate + counts.low
  if (total === 0) return null
  const text = MIX.filter((m) => counts[m.key] > 0)
    .map((m) => `${number.format(counts[m.key])} ${SEVERITY_LABEL[m.key].toLowerCase()}`)
    .join(', ')
  return (
    <span className="mt-1 flex flex-col gap-1">
      <span className="text-xs text-foreground-2">{text}</span>
      <span aria-hidden="true" className="flex h-1.5 gap-px overflow-hidden rounded-[3px] bg-muted">
        {MIX.map((m) =>
          counts[m.key] > 0 ? (
            <span
              key={m.key}
              className={`block h-full ${m.color}`}
              style={{ width: `${(counts[m.key] / total) * 100}%` }}
            />
          ) : null,
        )}
      </span>
    </span>
  )
}

function BelowTheLine({ overview }: { overview: OverviewResponse }) {
  const notDeployed = overview.tiers.not_deployed ?? 0
  return (
    <Section title="Below the line" description="Lower rank, nothing dropped.">
      <div className="grid gap-3 tab:grid-cols-3">
        {BELOW.map(({ tier, flags }) => (
          <Link
            key={tier}
            to="/alerts"
            search={{ tier: [tier] }}
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3.5 text-inherit no-underline hover:border-input hover:bg-sidebar"
          >
            <span className="flex items-center justify-between gap-2">
              <RankMarker flags={flags} />
              <span className="text-lg font-semibold tabular-nums">
                {number.format(overview.tiers[tier] ?? 0)}
              </span>
            </span>
            <span className="text-sm text-foreground-2">{TIER_INFO[tier].name}</span>
            <span className="text-xs text-muted-foreground">{TIER_INFO[tier].hint}</span>
            <SeverityMix counts={overview.tierSeverity[tier]} />
          </Link>
        ))}
      </div>
      <Link
        to="/alerts"
        search={{ tier: ['not_deployed'] }}
        className="flex items-start gap-3 rounded-lg border border-border bg-sidebar px-3.5 py-3 text-sm text-inherit no-underline hover:border-input"
      >
        <IconArchive
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-foreground-2"
          stroke={1.75}
        />
        <span className="flex min-w-0 flex-col gap-1">
          <b className="font-semibold">
            {number.format(notDeployed)} alert{notDeployed === 1 ? '' : 's'} in repos that are not
            deployed
          </b>
          <span className="text-muted-foreground">
            Ranked last. Archive those repos on GitHub or map them to a deployment if they do run
            somewhere.
          </span>
        </span>
        <IconChevronRight
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 self-center text-muted-foreground"
        />
      </Link>
    </Section>
  )
}

function NoRepoCallout({ items }: { items: readonly FindingListItem[] }) {
  const unmapped = items.filter(
    (i) => i.blindSpotType === 'no_repo_mapping' && i.state !== 'fixed' && i.deployments[0],
  )
  const first = unmapped[0]?.deployments[0]
  if (!first) return null
  const n = unmapped.length
  return (
    <Callout
      variant="warn"
      icon={IconPlugConnected}
      title={`${n} deployment${n === 1 ? ' has' : 's have'} no repo`}
    >
      <span className="flex flex-col gap-1">
        <span>
          {first.name}
          {first.server ? ` on ${first.server}` : ''} runs with no matching repo, so its exposure is
          unknown.
        </span>
        <Link
          to="/deployments/$id"
          params={{ id: String(first.id) }}
          className="font-medium text-accent-ink hover:underline"
        >
          Map a repo
        </Link>
      </span>
    </Callout>
  )
}

function RankedList({ items, total }: { items: readonly FindingListItem[]; total: number }) {
  const rows = ordered(items)
  return (
    <Section
      id="exposed-list"
      titleId="exposed-list-title"
      title="Exposed findings and blind spots"
      description="Ranked by exposure, then CVSS."
      actions={<FactorLegend className="hidden tab:flex" />}
    >
      {rows.length === 0 ? (
        <Callout icon={IconShieldCheck} title="Nothing exposed on a public app">
          No critical or high advisory in runtime code on a public deployment, and every deployed
          repo is covered. Lower tiers stay ranked below.
        </Callout>
      ) : (
        <div
          data-list
          aria-labelledby="exposed-list-title"
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          {rows.map((item, i) => (
            <FindingRow key={item.id} item={item} rank={i + 1} />
          ))}
        </div>
      )}
      {total > items.length ? (
        <Link
          to="/alerts"
          search={{ tier: ['blind_spot', 'exposed'] }}
          className="self-start text-sm text-accent-ink hover:underline"
        >
          {number.format(total - items.length)} more in All alerts
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
        <span className="min-w-[240px] flex-1">
          Snoozed and accepted findings stay in this list with their reason and expiry, and return
          to the top when it passes.
        </span>
        <span className="min-w-[240px] flex-1">
          Hinomi also scans the lockfile of each deployed repo against OSV.dev, so a repo with
          alerts off is still covered. Each finding shows its source.
        </span>
      </div>
    </Section>
  )
}

export function OverviewPage() {
  const overview = useQuery(overviewQuery)
  const top = useQuery(findingsQuery(TOP_PARAMS))

  const error = overview.error ?? top.error
  if (error) {
    return (
      <>
        <PageHeader title="Exposure" />
        <ErrorState
          title="Exposure did not load"
          error={error}
          onRetry={() => {
            void overview.refetch()
            void top.refetch()
          }}
        />
      </>
    )
  }
  if (!overview.data || !top.data) return <OverviewSkeleton />

  const data = overview.data
  if (data.sources.length === 0 && !data.lastScan) {
    return (
      <>
        <PageHeader title="Exposure">
          Critical or high advisories in runtime code on apps with a public domain, ranked first.
          Everything else stays listed under{' '}
          <Link to="/alerts" className={LEDE_LINK}>
            All alerts
          </Link>
          .
        </PageHeader>
        <EmptyState
          icon={IconRadar2}
          title="No scan yet"
          actions={
            <Button asChild>
              <Link to="/onboarding">
                <IconPlugConnected aria-hidden="true" />
                Connect sources
              </Link>
            </Button>
          }
        >
          Connect Coolify and GitHub and run the first scan. Hinomi joins your running apps with
          their advisories, so the few that are public and critical come first.
        </EmptyState>
      </>
    )
  }

  return (
    <>
      <PageHeader title={<Heading overview={data} />}>
        <Lede overview={data} />
      </PageHeader>
      <ScanStrip />
      <ExposureFunnel funnel={data.funnel} reach={data.funnelReach} />
      <div className="mt-7 grid items-start gap-6 desk:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-7">
          <RankedList items={top.data.items} total={top.data.total} />
          <BelowTheLine overview={data} />
        </div>
        <aside
          aria-label="Coverage and activity"
          className="grid gap-4 tab:max-desk:grid-cols-2 desk:flex desk:flex-col"
        >
          <NoRepoCallout items={top.data.items} />
          <SourceHealthPanel sources={data.sources} />
          <ActivityPanel items={data.recentActivity} />
        </aside>
      </div>
    </>
  )
}
