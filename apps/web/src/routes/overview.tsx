import type {
  FindingListItem,
  FindingTier,
  FixItem,
  OverviewResponse,
  SeverityCounts,
} from '@hinomi/shared'
import { useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import {
  IconAlertTriangle,
  IconArchive,
  IconChevronRight,
  IconPlugConnected,
  IconRadar2,
  IconShieldCheck,
} from '@tabler/icons-react'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView } from '@/components/split/split-view'
import { FindingPane } from '@/components/triage/finding-pane'
import { FixPane, FixRow } from '@/components/triage/fix-pane'
import {
  ListSkeleton,
  LoadedFooter,
  SegmentTabs,
  type SegmentTab,
} from '@/components/triage/list-parts'
import { TriageRow } from '@/components/triage/triage-row'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ActivityPanel } from '@/components/views/activity-panel'
import { Term } from '@/components/views/panel'
import { SourceHealthPanel } from '@/components/views/source-health-panel'
import { useDeferRequests } from '@/hooks/use-defer-requests'
import type { ExposureTab } from '@/lib/exposure-search'
import { isDecided, SEVERITY_LABEL, TIER_INFO } from '@/lib/finding-meta'
import { requestFix } from '@/lib/fix-request'
import { findingName, fixLabel, fixPlanRepos } from '@/lib/triage'
import {
  findingsInfiniteQuery,
  fixesInfiniteQuery,
  overviewQuery,
  type FindingsParams,
} from '@/lib/view-api'

const route = getRouteApi('/')
const number = new Intl.NumberFormat('en-US')
const PAGE = 50
const TOP: FindingTier[] = ['exposed', 'blind_spot']

/** What each findings tab lists. In progress holds running fixes and snoozed or accepted rows. */
const TAB_PARAMS: Record<Exclude<ExposureTab, 'fixes'>, FindingsParams> = {
  action: { tier: TOP, state: ['open'], limit: PAGE },
  blind: { tier: ['blind_spot'], limit: PAGE },
  progress: { tier: TOP, state: ['fixing', 'snoozed', 'accepted'], limit: PAGE },
}

const LIST_LABEL: Record<ExposureTab, string> = {
  action: 'Findings that need action',
  blind: 'Blind spots',
  progress: 'Findings in progress',
  fixes: 'Fixes that clear the most',
}

/** "4,917 alerts narrow to 267", with every funnel step behind it on hover and focus. */
function FunnelLine({ overview }: { overview: OverviewResponse }) {
  const f = overview.funnel
  const steps = [
    `${number.format(f.total)} open alerts`,
    `${number.format(f.deployed)} in a deployed repo`,
    `${number.format(f.runtime)} in runtime code`,
    `${number.format(f.criticalOrHigh)} critical or high`,
    `${number.format(f.exposed)} on a public app (exposed)`,
    `${number.format(f.needsAction)} need action`,
  ].join(', ')
  return (
    <Term definition={`Funnel: ${steps}.`}>
      {number.format(f.total)} alerts narrow to {number.format(f.exposed)}
    </Term>
  )
}

/** A source that failed or lacks a token, so a quiet list is never mistaken for a clean one. */
function SourceProblems({ overview }: { overview: OverviewResponse }) {
  const broken = overview.sources.filter(
    (s) => s.status === 'error' || s.status === 'missing_token',
  )
  if (!broken.length) return null
  const first = broken[0]!
  const name = first.kind === 'github' ? 'GitHub' : first.kind === 'osv' ? 'OSV.dev' : 'Coolify'
  return (
    <Link
      to="/settings"
      className="flex items-start gap-2 rounded-md text-xs text-foreground-2 no-underline hover:text-foreground"
    >
      <IconAlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-wait" />
      <span className="min-w-0">
        <b className="font-semibold">{name}</b>:{' '}
        {first.status === 'error' ? (first.lastError ?? 'the last sync failed') : 'no token'}
        {broken.length > 1 ? `, and ${broken.length - 1} more` : ''}. Open settings
      </span>
    </Link>
  )
}

const BELOW: FindingTier[] = ['internal', 'public_low', 'dev']

const MIX: { key: keyof SeverityCounts; color: string }[] = [
  { key: 'critical', color: 'bg-sev-critical' },
  { key: 'high', color: 'bg-sev-high' },
  { key: 'moderate', color: 'bg-sev-moderate' },
  { key: 'low', color: 'bg-sev-low' },
]

/** The severity mix of a tier as one thin bar, with the counts in words. */
function SeverityMix({ counts }: { counts: SeverityCounts | undefined }) {
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

/** The detail pane when nothing needs action: what ranks below, source health, activity. */
function QuietDetail({ overview }: { overview: OverviewResponse }) {
  const notDeployed = overview.tiers.not_deployed ?? 0
  return (
    <>
      <div className="flex flex-col gap-2">
        <h2 className="text-lg">Nothing needs action on a public app</h2>
        <p className="max-w-[68ch] text-foreground-2">
          No open critical or high advisory in runtime code on a public deployment, and no open
          blind spot. Lower tiers stay ranked below and listed under{' '}
          <Link to="/alerts" className="text-accent-ink hover:underline">
            All alerts
          </Link>
          .
        </p>
      </div>
      <section aria-labelledby="below-title" className="flex flex-col gap-3">
        <h2 id="below-title" className="text-md">
          Below the line
        </h2>
        <div className="grid gap-3 tab:grid-cols-3">
          {BELOW.map((tier) => (
            <Link
              key={tier}
              to="/alerts"
              search={{ tier: [tier] }}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3.5 text-inherit no-underline hover:border-input"
            >
              <span className="text-lg font-semibold tabular-nums">
                {number.format(overview.tiers[tier] ?? 0)}
              </span>
              <span className="text-sm text-foreground-2">{TIER_INFO[tier].name}</span>
              <SeverityMix counts={overview.tierSeverity[tier]} />
            </Link>
          ))}
        </div>
        <Link
          to="/alerts"
          search={{ tier: ['not_deployed'] }}
          className="flex items-start gap-3 rounded-lg border border-border bg-sidebar px-3.5 py-3 text-sm text-inherit no-underline hover:border-input"
        >
          <IconArchive aria-hidden="true" className="mt-0.5 size-4 shrink-0" stroke={1.75} />
          <span>
            <b className="font-semibold">
              {number.format(notDeployed)} alert{notDeployed === 1 ? '' : 's'} in repos that are not
              deployed
            </b>
            <span className="block text-muted-foreground">
              Ranked last. Archive those repos or map them to a deployment if they do run.
            </span>
          </span>
          <IconChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 self-center" />
        </Link>
      </section>
      <div className="grid items-start gap-4 desk:grid-cols-2">
        <SourceHealthPanel sources={overview.sources} />
        <ActivityPanel items={overview.recentActivity} />
      </div>
    </>
  )
}

/** In progress: running fixes first, then snoozed and accepted rows, each in rank order. */
function progressOrder(items: readonly FindingListItem[]): FindingListItem[] {
  return [...items.filter((i) => !isDecided(i.state)), ...items.filter((i) => isDecided(i.state))]
}

function Padded({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 px-4 pt-6 pb-10 tab:px-8 tab:pt-7">
      <h1 className="text-lg">Exposure</h1>
      {children}
    </div>
  )
}

export function OverviewPage() {
  const search = route.useSearch()
  const tab: ExposureTab = search.tab ?? 'action'
  const overview = useQuery(overviewQuery)
  const listTab = tab === 'fixes' ? 'action' : tab
  const list = useInfiniteQuery({
    ...findingsInfiniteQuery(TAB_PARAMS[listTab]),
    enabled: tab !== 'fixes',
  })
  // Their totals are the tab counts, so both load whatever tab is open.
  const progress = useInfiniteQuery(findingsInfiniteQuery(TAB_PARAMS.progress))
  const fixes = useInfiniteQuery(fixesInfiniteQuery())

  const defer = useDeferRequests()
  const rawItems = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const items = useMemo(
    () => (tab === 'progress' ? progressOrder(rawItems) : rawItems),
    [rawItems, tab],
  )
  const fixItems = useMemo(() => fixes.data?.pages.flatMap((p) => p.items) ?? [], [fixes.data])

  if (overview.error) {
    return (
      <Padded>
        <ErrorState
          title="Exposure did not load"
          error={overview.error}
          onRetry={() => void overview.refetch()}
        />
      </Padded>
    )
  }
  const data = overview.data
  if (data && data.sources.length === 0 && !data.lastScan) {
    return (
      <Padded>
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
      </Padded>
    )
  }

  const tabs: SegmentTab<ExposureTab>[] = [
    {
      key: 'action',
      label: 'Needs action',
      count: data ? data.funnel.needsAction + data.blindSpots.needsAction : null,
    },
    { key: 'blind', label: 'Blind', count: data?.blindSpots.total ?? null },
    { key: 'progress', label: 'In progress', count: progress.data?.pages[0]?.total ?? null },
    { key: 'fixes', label: 'By fix', count: fixes.data?.pages[0]?.total ?? null },
  ]

  const header = (
    <SplitListHeader title="Exposure" meta={data ? <FunnelLine overview={data} /> : undefined}>
      <SegmentTabs tabs={tabs} current={tab} param="tab" label="Exposure views" />
      {data ? <SourceProblems overview={data} /> : null}
    </SplitListHeader>
  )

  if (tab === 'fixes') {
    const first = fixes.data?.pages[0]
    return (
      <SplitView<FixItem>
        items={fixItems}
        getKey={(fix) => fix.key}
        getLabel={fixLabel}
        listLabel={LIST_LABEL.fixes}
        listHeader={header}
        renderRow={(fix, { index }) => <FixRow fix={fix} rank={index + 1} />}
        renderDetail={(fix, { focused }) => <FixPane fix={fix} focused={focused} />}
        actions={{ fix: (fix) => requestFix({ repos: fixPlanRepos(fix) }) }}
        emptyList={
          fixes.error ? (
            <div className="p-[18px]">
              <ErrorState
                title="Fixes did not load"
                error={fixes.error}
                onRetry={() => void fixes.refetch()}
              />
            </div>
          ) : !first ? (
            <ListSkeleton label="Loading fixes" />
          ) : (
            <div className="p-[18px]">
              <Callout icon={IconShieldCheck} title="No bump to make">
                No open advisory has a package version to bump. Blind spots and findings without a
                patch are listed under the other tabs.
              </Callout>
            </div>
          )
        }
        listFooter={
          first ? (
            <LoadedFooter
              loaded={fixItems.length}
              total={first.total}
              noun="fixes"
              order="Ranked by exposure"
              hasMore={fixes.hasNextPage}
              loading={fixes.isFetchingNextPage}
              onMore={() => void fixes.fetchNextPage()}
            />
          ) : undefined
        }
      />
    )
  }

  const first = list.data?.pages[0]
  const total = first?.total ?? 0
  return (
    <SplitView<FindingListItem>
      items={items}
      getKey={(item) => item.id}
      getLabel={findingName}
      listLabel={LIST_LABEL[tab]}
      listHeader={header}
      getGroup={
        tab === 'progress'
          ? (item) =>
              isDecided(item.state)
                ? { key: 'decided', label: 'Snoozed or accepted' }
                : { key: 'fixing', label: 'Fix running' }
          : undefined
      }
      renderRow={(item, { index }) => <TriageRow item={item} rank={index + 1} />}
      renderDetail={(item, { focused, index }) => (
        <FindingPane
          key={item.id}
          id={item.id}
          rank={tab === 'action' ? index + 1 : undefined}
          layout={focused ? 'two' : 'stack'}
          deferRequest={defer.request}
        />
      )}
      actions={defer.actions}
      emptyList={
        list.error ? (
          <div className="p-[18px]">
            <ErrorState
              title="This list did not load"
              error={list.error}
              onRetry={() => void list.refetch()}
            />
          </div>
        ) : !first ? (
          <ListSkeleton label="Loading exposure" />
        ) : (
          <div className="p-[18px]">
            <Callout icon={IconShieldCheck} title={EMPTY_TITLE[listTab]}>
              {EMPTY_TEXT[listTab]}
            </Callout>
          </div>
        )
      }
      emptyDetail={tab === 'action' && first && data ? <QuietDetail overview={data} /> : undefined}
      listFooter={
        first ? (
          <LoadedFooter
            loaded={rawItems.length}
            total={total}
            order="Ranked by exposure"
            hasMore={list.hasNextPage}
            loading={list.isFetchingNextPage}
            onMore={() => void list.fetchNextPage()}
          />
        ) : undefined
      }
    />
  )
}

const EMPTY_TITLE: Record<Exclude<ExposureTab, 'fixes'>, string> = {
  action: 'Nothing exposed on a public app',
  blind: 'No blind spots',
  progress: 'Nothing in progress',
}

const EMPTY_TEXT: Record<Exclude<ExposureTab, 'fixes'>, string> = {
  action:
    'No open critical or high advisory in runtime code on a public deployment, and every deployed repo is covered. Lower tiers stay ranked in All alerts.',
  blind: 'Every deployed repo has alerts on and a lockfile Hinomi can read.',
  progress:
    'No fix is running and nothing exposed is snoozed or accepted. Snoozed and accepted findings stay here with their reason and expiry.',
}
