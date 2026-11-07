import { GUARD_CHECKS, GUARD_COPY, type FindingListItem, type GuardLevel } from '@hinomi/shared'
import { useCallback, useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { IconCheck, IconFilterOff, IconSettings2, IconShieldHalf, IconX } from '@tabler/icons-react'
import { GuardsCard } from '@/components/guards/guards-card'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView, type SplitGroup } from '@/components/split/split-view'
import { DetailEmpty } from '@/components/states/detail-empty'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { FindingPane } from '@/components/triage/finding-pane'
import { ListSkeleton, LoadedFooter } from '@/components/triage/list-parts'
import { TriageRow } from '@/components/triage/triage-row'
import { Button } from '@/components/ui/button'
import { useDeferRequests } from '@/hooks/use-defer-requests'
import { splitGroups, type RowGroup } from '@/lib/alerts-search'
import { TIER_INFO, tierTitle } from '@/lib/finding-meta'
import { GUARD_LEVEL_LABEL, GUARD_LEVELS_WORST_FIRST } from '@/lib/guard-meta'
import { guardsParams, hasGuardFilters, type GuardsSearch } from '@/lib/guards-search'
import { findingName } from '@/lib/triage'
import { cn } from '@/lib/utils'
import { findingsInfiniteQuery, overviewQuery } from '@/lib/view-api'

const route = getRouteApi('/guards')
const PAGE = 50
const number = new Intl.NumberFormat('en-US')

const SELECT =
  'h-[30px] w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm text-foreground focus-visible:outline-offset-[-1px]'

/** Where the checks and the overrides are listed. */
const CHECKS_SETTINGS = { to: '/settings', search: { sel: 'checks' } } as const

function GuardsFilters({
  search,
  onChange,
}: {
  search: GuardsSearch
  onChange: (patch: Partial<GuardsSearch>) => void
}) {
  const levels = search.level ?? []
  return (
    <div role="search" aria-label="Filter guards" className="flex flex-col gap-2.5">
      <div role="group" aria-label="Level" className="flex flex-wrap gap-1.5">
        {GUARD_LEVELS_WORST_FIRST.map((level) => {
          // No level picked means all of them: every chip reads as on.
          const pressed = levels.length === 0 || levels.includes(level)
          return (
            <button
              key={level}
              type="button"
              aria-pressed={pressed}
              onClick={() => {
                const base = levels.length === 0 ? [...GUARD_LEVELS_WORST_FIRST] : levels
                const next: GuardLevel[] = pressed
                  ? base.filter((l) => l !== level)
                  : [...base, level]
                onChange({
                  level:
                    next.length === 0 || next.length === GUARD_LEVELS_WORST_FIRST.length
                      ? undefined
                      : next,
                })
              }}
              className={cn(
                'inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold',
                pressed
                  ? 'border-transparent bg-accent text-accent-ink'
                  : 'border-input bg-card text-foreground-2 hover:bg-muted',
              )}
            >
              {pressed ? <IconCheck aria-hidden="true" className="size-3.5" stroke={2.2} /> : null}
              {GUARD_LEVEL_LABEL[level]}
            </button>
          )
        })}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label="Check"
          className={SELECT}
          value={search.check?.length === 1 ? search.check[0] : 'all'}
          onChange={(e) =>
            onChange({
              check:
                e.target.value === 'all'
                  ? undefined
                  : [e.target.value as (typeof GUARD_CHECKS)[number]],
            })
          }
        >
          <option value="all">Every check</option>
          {GUARD_CHECKS.map((check) => (
            <option key={check} value={check}>
              {GUARD_COPY[check].title}
            </option>
          ))}
        </select>
        <select
          aria-label="State"
          className={SELECT}
          value={search.state?.length === 1 ? search.state[0] : 'all'}
          onChange={(e) =>
            onChange({
              state: e.target.value === 'all' ? undefined : [e.target.value as 'open'],
            })
          }
        >
          <option value="all">Any state but fixed</option>
          <option value="open">Open</option>
          <option value="snoozed">Snoozed</option>
          <option value="accepted">Accepted or turned off</option>
          <option value="fixed">Resolved</option>
        </select>
      </div>
    </div>
  )
}

/**
 * Guard findings on their own: the same rows, tiers and detail pane as All alerts, filtered on
 * kind guard, with level, check and state filters. Nothing is hidden: turned off checks stay
 * listed as accepted.
 */
export function GuardsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const params = useMemo(() => guardsParams(search, PAGE), [search])
  const query = useInfiniteQuery(findingsInfiniteQuery(params))
  const overview = useQuery(overviewQuery)
  const defer = useDeferRequests()

  const update = useCallback(
    (patch: Partial<GuardsSearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch, sel: undefined }), replace: true })
    },
    [navigate],
  )
  const clearFilters = () => void navigate({ search: {}, replace: true })

  const pages = useMemo(() => query.data?.pages ?? [], [query.data])
  const first = pages[0]
  const loaded = useMemo(() => pages.flatMap((p) => p.items), [pages])
  const groups = useMemo(() => (first ? splitGroups(loaded, first) : []), [loaded, first])
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const groupOf = useMemo(() => {
    const map = new Map<number, RowGroup>()
    for (const g of groups) for (const item of g.items) map.set(item.id, g)
    return map
  }, [groups])

  const filtered = hasGuardFilters(search)
  const total = first?.total ?? 0
  const getGroup = (item: FindingListItem): SplitGroup | undefined => {
    const g = groupOf.get(item.id)
    if (!g) return undefined
    return {
      key: g.key,
      label: g.key in TIER_INFO ? tierTitle(g.key as keyof typeof TIER_INFO) : g.label,
      count: number.format(g.count),
    }
  }

  const header = (
    <SplitListHeader
      title="Guards"
      meta={first ? `${number.format(total)} finding${total === 1 ? '' : 's'}` : undefined}
    >
      <GuardsFilters search={search} onChange={update} />
      <div className="flex flex-wrap items-center gap-1.5">
        {filtered ? (
          <Button variant="ghost" size="xs" onClick={clearFilters}>
            <IconX aria-hidden="true" />
            Clear filters
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="xs" className="ml-auto">
          <Link {...CHECKS_SETTINGS}>
            <IconSettings2 aria-hidden="true" />
            Checks and overrides
          </Link>
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {first ? `${number.format(total)} ${filtered ? 'match' : 'guard findings'}` : ''}
      </p>
    </SplitListHeader>
  )

  let emptyList: React.ReactNode
  if (query.error && !first) {
    emptyList = (
      <div className="p-[18px]">
        <ErrorState
          title="Guards did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    )
  } else if (!first) {
    emptyList = <ListSkeleton label="Loading guards" />
  } else if (filtered) {
    emptyList = (
      <EmptyState
        icon={IconFilterOff}
        title="No guard finding matches these filters"
        actions={
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        }
      >
        Resolved findings are left out unless the state filter asks for them.
      </EmptyState>
    )
  } else {
    emptyList = (
      <EmptyState
        icon={IconShieldHalf}
        title="No guard findings"
        actions={
          <Button asChild variant="outline">
            <Link {...CHECKS_SETTINGS}>See the checks</Link>
          </Button>
        }
      >
        Guards check how each deployment is configured: a container running as root, a mounted
        Docker socket, a shared network, a runtime near end of life. Findings land here and in All
        alerts, ranked next to advisories.
      </EmptyState>
    )
  }

  const summary = (
    <div className="flex flex-col gap-6">
      <DetailEmpty icon={IconShieldHalf} title="Configuration checks, ranked like advisories">
        <p>
          Each check reads what a source reports about a deployment or a repo. A check that cannot
          tell says unknown, never a silent pass. Turning a check off keeps it running and keeps the
          finding listed as accepted, with your reason.
        </p>
      </DetailEmpty>
      {overview.data ? (
        <GuardsCard counts={overview.data.guardCounts} className="max-w-[560px]" />
      ) : null}
    </div>
  )

  return (
    <SplitView<FindingListItem>
      items={items}
      getKey={(item) => item.id}
      getLabel={findingName}
      listLabel={`Guard findings, ${number.format(total)} matching`}
      listHeader={header}
      getGroup={getGroup}
      renderRow={(item) => <TriageRow item={item} right="age" />}
      renderDetail={(item, { focused }) => (
        <FindingPane
          key={item.id}
          id={item.id}
          layout={focused ? 'two' : 'stack'}
          deferRequest={defer.request}
        />
      )}
      actions={{ snooze: defer.actions.snooze, accept: defer.actions.accept }}
      emptyList={emptyList}
      emptyDetail={<div className="pt-14">{summary}</div>}
      listFooter={
        first ? (
          <LoadedFooter
            loaded={loaded.length}
            total={total}
            order="Grouped by tier"
            hasMore={query.hasNextPage}
            loading={query.isFetchingNextPage}
            onMore={() => void query.fetchNextPage()}
          />
        ) : undefined
      }
    />
  )
}
