import type { FindingGroup, FindingListItem } from '@hinomi/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { IconFilterOff, IconInfoCircle, IconListDetails, IconX } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Button } from '@/components/ui/button'
import { AlertsFilters } from '@/components/views/alerts-filters'
import { AlertsTable } from '@/components/views/alerts-table'
import { BulkBar } from '@/components/views/bulk-bar'
import { ScanStrip } from '@/components/views/scan-strip'
import {
  alertsParams,
  DEFAULT_GROUP,
  hasFilters,
  splitGroups,
  type AlertsSearch,
} from '@/lib/alerts-search'
import { blindSpotSubject } from '@/lib/finding-meta'
import { activeRowIndex } from '@/lib/list-nav'
import { isTypingTarget } from '@/lib/shortcuts'
import { findingsInfiniteQuery } from '@/lib/view-api'

const route = getRouteApi('/alerts')
const PAGE = 50
const number = new Intl.NumberFormat('en-US')

const GROUPS: { value: FindingGroup; label: string }[] = [
  { value: 'tier', label: 'Tier' },
  { value: 'repo', label: 'Repo' },
  { value: 'advisory', label: 'Advisory' },
]

function GroupSwitch({
  value,
  onChange,
}: {
  value: FindingGroup
  onChange: (g: FindingGroup) => void
}) {
  return (
    <fieldset className="flex items-center gap-2">
      <legend className="float-left mr-2 text-xs text-muted-foreground">Group by</legend>
      <div className="inline-flex gap-0.5 rounded-md bg-muted p-0.5">
        {GROUPS.map((g) => (
          <label
            key={g.value}
            className="cursor-pointer rounded-sm px-2 py-1 text-xs text-foreground-2 has-checked:bg-card has-checked:text-foreground has-checked:shadow-[0_1px_2px_oklch(0.2_0.02_265/0.12)] has-focus-visible:outline-2 has-focus-visible:outline-ring"
          >
            <input
              type="radio"
              name="alerts-group"
              value={g.value}
              checked={value === g.value}
              onChange={() => onChange(g.value)}
              className="sr-only"
            />
            {g.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function itemLabel(item: FindingListItem | undefined, id: number): string {
  if (!item) return `finding ${id}`
  if (item.kind === 'blind_spot') return `blind spot on ${blindSpotSubject(item)}`
  return `${item.advisory?.packageName ?? 'advisory'}${item.repo ? ` in ${item.repo.fullName}` : ''}`
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
  if (chips.length === 0) return null
  return (
    <>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-accent pr-0.5 pl-2.5 text-xs text-accent-ink"
        >
          {chip.label}
          <button
            type="button"
            onClick={() => onChange(chip.clear)}
            aria-label={`Remove filter ${chip.label}`}
            className="grid size-5 cursor-pointer place-items-center rounded-full hover:bg-card"
          >
            <IconX aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
    </>
  )
}

export function AlertsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const group = search.group ?? DEFAULT_GROUP
  const params = useMemo(() => alertsParams(search, PAGE), [search])
  const query = useInfiniteQuery(findingsInfiniteQuery(params))
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState('')

  const update = useCallback(
    (patch: Partial<AlertsSearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
    },
    [navigate],
  )

  // New filters mean new rows: a selection over rows no longer shown would surprise.
  const paramsKey = JSON.stringify(params)
  const [selectionKey, setSelectionKey] = useState(paramsKey)
  if (selectionKey !== paramsKey) {
    setSelectionKey(paramsKey)
    setSelected(new Set())
  }

  const pages = useMemo(() => query.data?.pages ?? [], [query.data])
  const first = pages[0]
  const items = useMemo(() => pages.flatMap((p) => p.items), [pages])
  const groups = useMemo(() => (first ? splitGroups(items, first) : []), [items, first])
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

  // x selects the row picked with j/k, like the design's keyboard map.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'x' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"]')) return
      const index = activeRowIndex()
      const row = document.querySelectorAll<HTMLElement>('[data-list] [data-row]')[index]
      const id = Number(row?.dataset.findingId)
      if (!id) return
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

  let body: React.ReactNode
  if (query.error && !first) {
    body = (
      <ErrorState
        title="Alerts did not load"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    )
  } else if (!first) {
    body = <LoadingState layout="table" label="Loading alerts" />
  } else if (total === 0 && !filtered) {
    body = (
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
  } else if (total === 0) {
    body = (
      <EmptyState
        icon={IconFilterOff}
        title="No alerts match these filters"
        actions={
          <Button
            variant="outline"
            onClick={() => void navigate({ search: { group: search.group }, replace: true })}
          >
            Clear filters
          </Button>
        }
      >
        Fixed findings are left out unless the state filter asks for them. Clear the filters to see
        every alert again, ranked by exposure.
      </EmptyState>
    )
  } else {
    const loaded = items.length
    body = (
      <>
        <AlertsTable
          groups={groups}
          by={first.group}
          selected={selected}
          onToggle={toggle}
          caption={`Alerts, ${number.format(total)} matching, grouped by ${first.group}`}
        />
        {query.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading' : `Show ${Math.min(PAGE, total - loaded)} more`}
              <span className="text-muted-foreground">
                ({number.format(total - loaded)} not loaded)
              </span>
            </Button>
          </div>
        ) : null}
        {query.error ? (
          <ErrorState
            className="mt-3"
            title="More alerts did not load"
            error={query.error}
            onRetry={() => void query.fetchNextPage()}
          />
        ) : null}
      </>
    )
  }

  return (
    <>
      <PageHeader title="All alerts">
        Every open alert from GitHub and the OSV lockfile scan, ranked by exposure. Filters narrow
        the view, nothing is removed.
      </PageHeader>
      <ScanStrip />
      <AlertsFilters search={search} onChange={update} />
      <div className="mt-2.5 mb-3 flex flex-wrap items-center gap-2.5 px-0.5 text-xs text-muted-foreground">
        <span aria-live="polite">
          {first ? (
            <>
              <b className="font-medium text-foreground">{number.format(total)}</b>{' '}
              {filtered ? 'match' : `alert${total === 1 ? '' : 's'}`}.{' '}
              {group === 'tier'
                ? 'Sorted by exposure tier, then rank.'
                : group === 'none'
                  ? 'Sorted by rank.'
                  : 'Groups sorted by their best ranked alert.'}
            </>
          ) : (
            'Loading'
          )}
          {query.isFetching && first && !query.isFetchingNextPage ? ' Updating.' : ''}
        </span>
        <ScopeChips search={search} items={items} onChange={update} />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void navigate({ search: { group: search.group }, replace: true })}
          >
            <IconX aria-hidden="true" />
            Clear filters
          </Button>
        ) : null}
        <span className="ml-auto">
          <GroupSwitch
            value={group}
            onChange={(g) => update({ group: g === DEFAULT_GROUP ? undefined : g })}
          />
        </span>
      </div>
      {body}
      {selected.size > 0 ? (
        <BulkBar
          ids={[...selected]}
          labelOf={(id) => itemLabel(byId.get(id), id)}
          onClear={() => setSelected(new Set())}
          onDone={(result) => {
            setNotice(
              `${result.kind === 'snooze' ? 'Snoozed' : 'Accepted the risk of'} ${result.ok} finding${result.ok === 1 ? '' : 's'}.`,
            )
            if (result.failed.length === 0) setSelected(new Set())
            else setSelected(new Set(result.failed.map((f) => f.id)))
          }}
        />
      ) : null}
      <p role="status" className="sr-only">
        {notice}
      </p>
      <details className="group mt-4 rounded-lg border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <IconInfoCircle aria-hidden="true" className="size-4 text-foreground-2" stroke={1.75} />
          <h2 className="text-base">How ranking works</h2>
        </summary>
        <div className="flex max-w-[68ch] flex-col gap-2.5 px-4 pb-4 text-foreground-2">
          <p>
            Each alert gets four yes or no factors: <b>S</b> critical or high severity, <b>R</b>{' '}
            runtime dependency, <b>D</b> repo is deployed, <b>P</b> deployment has a public domain.
            Tiers follow from those factors, then CVSS sorts within a tier.
          </p>
          <p>
            Blind spots, such as a deployed repo with Dependabot alerts off, rank with the criticals
            because their real severity is unknown. Hinomi scans the lockfile of every deployed repo
            against OSV.dev, so each alert lists its source: GitHub, OSV or both.
          </p>
          <p>
            Snoozed and accepted alerts keep their tier and show their reason. Hinomi never closes
            or dismisses alerts on GitHub. A verified fix closes them on its own.
          </p>
        </div>
      </details>
    </>
  )
}
