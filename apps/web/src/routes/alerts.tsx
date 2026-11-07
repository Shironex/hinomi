import type { FindingGroup, FindingListItem, FindingState } from '@hinomi/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { IconFilterOff, IconListDetails, IconX } from '@tabler/icons-react'
import { useShell } from '@/components/shell/shell-context'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView, type SplitGroup } from '@/components/split/split-view'
import { FindingPane } from '@/components/triage/finding-pane'
import { ListSkeleton, LoadedFooter } from '@/components/triage/list-parts'
import { TriageRow } from '@/components/triage/triage-row'
import { Button } from '@/components/ui/button'
import { AlertsFilters } from '@/components/views/alerts-filters'
import { BulkBar, type BulkAction } from '@/components/views/bulk-bar'
import { useDeferRequests } from '@/hooks/use-defer-requests'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import {
  alertsParams,
  hasFilters,
  splitGroups,
  type AlertsSearch,
  type RowGroup,
} from '@/lib/alerts-search'
import { blindSpotSubject, TIER_INFO, tierTitle } from '@/lib/finding-meta'
import { activeRowIndex } from '@/lib/list-nav'
import { isTypingTarget } from '@/lib/shortcuts'
import { findingName } from '@/lib/triage'
import { findingsInfiniteQuery } from '@/lib/view-api'

const route = getRouteApi('/alerts')
const PAGE = 50
const REOPENABLE = new Set<FindingState>(['snoozed', 'accepted'])
const BULK_DONE: Record<BulkAction, string> = {
  snooze: 'Snoozed',
  accept: 'Accepted the risk of',
  reopen: 'Removed the decision on',
}
const number = new Intl.NumberFormat('en-US')

function itemLabel(item: FindingListItem | undefined, id: number): string {
  if (!item) return `finding ${id}`
  if (item.kind === 'blind_spot') return `blind spot on ${blindSpotSubject(item)}`
  if (item.kind === 'coverage_note') return `image only note on ${blindSpotSubject(item)}`
  if (item.kind === 'guard') return `${item.guard?.title ?? 'guard'} on ${findingName(item)}`
  return `${item.advisory?.packageName ?? 'advisory'}${item.repo ? ` in ${item.repo.fullName}` : ''}`
}

function groupName(group: RowGroup, by: FindingGroup): string {
  if (by === 'tier' && group.key in TIER_INFO) return tierTitle(group.key as keyof typeof TIER_INFO)
  return group.label
}

/** Selects every loaded row of a group; indeterminate when only some are. */
function GroupCheckbox({
  ids,
  label,
  selected,
  onToggle,
}: {
  ids: readonly number[]
  label: string
  selected: ReadonlySet<number>
  onToggle: (ids: number[], on: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = !all && ids.some((id) => selected.has(id))
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some
  }, [some])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={() => onToggle([...ids], !all)}
      aria-label={`Select the ${ids.length} loaded in ${label}`}
      className="size-4 cursor-pointer accent-primary"
    />
  )
}

/** Repo and deployment filters arrive from links; show them as removable chips. */
function ScopeChips({
  search,
  items,
  onChange,
}: {
  search: AlertsSearch
  items: readonly FindingListItem[]
  onChange: (patch: Partial<AlertsSearch>) => void
}) {
  const chips: { key: string; label: string; clear: Partial<AlertsSearch> }[] = []
  for (const id of search.repo ?? []) {
    const name = items.find((i) => i.repo?.id === id)?.repo?.fullName ?? `repo ${id}`
    chips.push({
      key: `r${id}`,
      label: `Repo: ${name}`,
      clear: { repo: search.repo?.filter((r) => r !== id) },
    })
  }
  for (const id of search.deployment ?? []) {
    const name =
      items.flatMap((i) => i.deployments).find((d) => d.id === id)?.name ?? `deployment ${id}`
    chips.push({
      key: `d${id}`,
      label: `App: ${name}`,
      clear: { deployment: search.deployment?.filter((d) => d !== id) },
    })
  }
  return chips.map((chip) => (
    <span
      key={chip.key}
      className="inline-flex h-7 items-center gap-1 rounded-full bg-accent pr-0.5 pl-2.5 text-xs text-accent-ink"
    >
      {chip.label}
      <button
        type="button"
        onClick={() => onChange(chip.clear)}
        aria-label={`Remove filter ${chip.label}`}
        className="grid size-6 cursor-pointer place-items-center rounded-full hover:bg-card"
      >
        <IconX aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  ))
}

export function AlertsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const { counts } = useShell()
  const wide = useMediaQuery(SPLIT_QUERY)
  const params = useMemo(() => alertsParams(search, PAGE), [search])
  const query = useInfiniteQuery(findingsInfiniteQuery(params))
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState('')
  const defer = useDeferRequests()

  const update = useCallback(
    (patch: Partial<AlertsSearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch, sel: undefined }), replace: true })
    },
    [navigate],
  )
  const clearFilters = () => void navigate({ search: { group: search.group }, replace: true })

  // New filters mean new rows: a selection over rows the filters now hide would surprise.
  const paramsKey = JSON.stringify(params)
  const [selectionKey, setSelectionKey] = useState(paramsKey)
  if (selectionKey !== paramsKey) {
    setSelectionKey(paramsKey)
    setSelected(new Set())
  }

  const pages = useMemo(() => query.data?.pages ?? [], [query.data])
  const first = pages[0]
  const loadedItems = useMemo(() => pages.flatMap((p) => p.items), [pages])
  const groups = useMemo(() => (first ? splitGroups(loadedItems, first) : []), [loadedItems, first])
  // Rows in group order, each knowing its group for the headings between them.
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const groupOf = useMemo(() => {
    const map = new Map<number, RowGroup>()
    for (const g of groups) for (const item of g.items) map.set(item.id, g)
    return map
  }, [groups])
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  const toggle = useCallback((ids: number[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  // x selects the current row: the one shown in the detail pane, or the j/k row on a phone.
  const current = useRef<() => number | undefined>(() => undefined)
  useEffect(() => {
    current.current = () => {
      if (!wide) return items[activeRowIndex()]?.id
      const found = items.find((i) => String(i.id) === String(search.sel))
      return (found ?? items[0])?.id
    }
  })
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'x' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return
      const id = current.current()
      if (id === undefined) return
      event.preventDefault()
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const filtered = hasFilters(search)
  const total = first?.total ?? 0
  const by = first?.group ?? 'none'
  const getGroup =
    by === 'none'
      ? undefined
      : (item: FindingListItem): SplitGroup | undefined => {
          const g = groupOf.get(item.id)
          if (!g) return undefined
          const name = groupName(g, by)
          const ids = g.items.map((i) => i.id)
          return {
            key: g.key,
            label: (
              <>
                <GroupCheckbox
                  ids={ids}
                  label={g.label || name}
                  selected={selected}
                  onToggle={toggle}
                />
                <span className={by === 'tier' ? '' : 'font-mono'}>{name}</span>
              </>
            ),
            count:
              g.items.length < g.count
                ? `${number.format(g.count)}, ${number.format(g.items.length)} loaded`
                : number.format(g.count),
          }
        }

  const header = (
    <SplitListHeader
      title="All alerts"
      meta={
        first
          ? filtered && counts.alerts != null
            ? `${number.format(total)} of ${number.format(counts.alerts)}`
            : `${number.format(total)} alert${total === 1 ? '' : 's'}`
          : undefined
      }
    >
      <AlertsFilters search={search} onChange={update} />
      {filtered ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <ScopeChips search={search} items={items} onChange={update} />
          <Button variant="ghost" size="xs" onClick={clearFilters}>
            <IconX aria-hidden="true" />
            Clear filters
          </Button>
        </div>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {first ? `${number.format(total)} ${filtered ? 'match' : 'alerts'}` : ''}
        {query.isFetching && first && !query.isFetchingNextPage ? ', updating' : ''}
      </p>
    </SplitListHeader>
  )

  let emptyList: React.ReactNode
  if (query.error && !first) {
    emptyList = (
      <div className="p-[18px]">
        <ErrorState
          title="Alerts did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </div>
    )
  } else if (!first) {
    emptyList = <ListSkeleton label="Loading alerts" />
  } else if (!filtered) {
    emptyList = (
      <EmptyState
        icon={IconListDetails}
        title="No alerts yet"
        actions={
          <Button asChild variant="outline">
            <Link to="/onboarding">Connect GitHub</Link>
          </Button>
        }
      >
        Alerts arrive from Dependabot and from OSV.dev lockfile scans once GitHub is connected.
        Repos that are not deployed are ranked last, never dropped.
      </EmptyState>
    )
  } else {
    emptyList = (
      <EmptyState
        icon={IconFilterOff}
        title="No alerts match these filters"
        actions={
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        }
      >
        Fixed findings are left out unless the state filter asks for them.
      </EmptyState>
    )
  }

  const bulk =
    selected.size > 0 ? (
      <div className="border-t border-border p-3">
        <BulkBar
          className="static mt-0 shadow-none"
          ids={[...selected]}
          labelOf={(id) => itemLabel(byId.get(id), id)}
          allowNewAdvisory={[...selected].every((id) => byId.get(id)?.kind === 'advisory')}
          canReopen={[...selected].some((id) => REOPENABLE.has(byId.get(id)?.state ?? 'open'))}
          onClear={() => setSelected(new Set())}
          onDone={(result) => {
            setNotice(
              `${BULK_DONE[result.kind]} ${result.ok} finding${result.ok === 1 ? '' : 's'}.`,
            )
            if (result.failed.length === 0) setSelected(new Set())
            else setSelected(new Set(result.failed.map((f) => f.id)))
          }}
        />
      </div>
    ) : null

  return (
    <>
      <SplitView<FindingListItem>
        items={items}
        getKey={(item) => item.id}
        getLabel={findingName}
        listLabel={`Alerts, ${number.format(total)} matching`}
        listHeader={header}
        getGroup={getGroup}
        searchable
        renderRowLead={(item) => (
          <input
            type="checkbox"
            checked={selected.has(item.id)}
            onChange={(e) => toggle([item.id], e.target.checked)}
            aria-label={`Select ${findingName(item)}${item.repo && item.kind === 'advisory' ? ` in ${item.repo.fullName}` : ''}`}
            className="mt-[5px] size-4 cursor-pointer accent-primary"
          />
        )}
        renderRow={(item) => <TriageRow item={item} right="age" />}
        renderDetail={(item, { focused }) => (
          <FindingPane
            key={item.id}
            id={item.id}
            layout={focused ? 'two' : 'stack'}
            deferRequest={defer.request}
          />
        )}
        actions={defer.actions}
        emptyList={emptyList}
        listFooter={
          first ? (
            <LoadedFooter
              loaded={loadedItems.length}
              total={total}
              order={by === 'none' ? 'Ranked by exposure' : `Grouped by ${by}`}
              hasMore={query.hasNextPage}
              loading={query.isFetchingNextPage}
              onMore={() => void query.fetchNextPage()}
            >
              {query.error ? (
                <div className="border-t border-border p-3">
                  <ErrorState
                    title="More alerts did not load"
                    error={query.error}
                    onRetry={() => void query.fetchNextPage()}
                  />
                </div>
              ) : null}
              {bulk}
            </LoadedFooter>
          ) : (
            bulk
          )
        }
      />
      <p role="status" className="sr-only">
        {notice}
      </p>
    </>
  )
}
