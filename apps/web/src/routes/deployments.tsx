import type { DeploymentItem } from '@hinomi/shared'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { IconArchive, IconServer2, IconServerOff } from '@tabler/icons-react'
import { KeyHintBar } from '@/components/shell/key-hints'
import type { KeyHint } from '@/components/shell/key-hints-meta'
import { TopBar } from '@/components/shell/top-bar'
import { SplitListHeader } from '@/components/split/split-parts'
import { SplitView } from '@/components/split/split-view'
import { EmptyState } from '@/components/states/empty-state'
import { ErrorState } from '@/components/states/error-state'
import { LoadingState } from '@/components/states/loading-state'
import { Button } from '@/components/ui/button'
import { DeploymentDetailView } from '@/components/views/deployment-detail-view'
import {
  DeploymentRow,
  HeatLegend,
  ServerHeading,
  TileBody,
} from '@/components/views/deployment-map'
import { tileClass } from '@/components/views/deployment-map-meta'
import { ScanStrip } from '@/components/views/scan-strip'
import { SPLIT_QUERY, TAB_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import { ApiError } from '@/lib/api'
import { byExposure, groupByServer, SERVER_UNKNOWN } from '@/lib/deployment-map'
import type { DeploymentsSearch } from '@/lib/deployments-search'
import { cn } from '@/lib/utils'
import { deploymentQuery, deploymentsQuery, reposQuery } from '@/lib/view-api'

const route = getRouteApi('/deployments')

const MAP_HINTS: readonly KeyHint[] = [
  { keys: ['j', 'k'], label: 'move' },
  { keys: ['Enter'], label: 'open' },
  { keys: ['g'], label: 'go to' },
]

type Order = NonNullable<DeploymentsSearch['order']>

/**
 * The map and the page states fill the split route on their own: from 1100 px the shell leaves
 * the top bar and key bar to the view, below it the view brings its own padding.
 */
function MapFrame({ wide, children }: { wide: boolean; children: ReactNode }) {
  const body = (
    <div className="flex w-full max-w-[1280px] flex-col gap-5 px-4 pt-6 pb-10 tab:px-8 tab:pt-7">
      {children}
    </div>
  )
  if (!wide) return body
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      <KeyHintBar hints={MAP_HINTS} />
    </div>
  )
}

/** Map, list by server, list by exposure. The map needs room, so the phone gets the lists. */
function ViewSwitch({ current, withMap }: { current: 'map' | Order; withMap: boolean }) {
  const options: { key: 'map' | Order; label: string }[] = [
    ...(withMap ? [{ key: 'map' as const, label: 'Map' }] : []),
    { key: 'server', label: 'By server' },
    { key: 'exposure', label: 'By exposure' },
  ]
  return (
    <nav
      aria-label="Deployments view"
      className="flex gap-1 rounded-md border border-border bg-sidebar p-[3px]"
    >
      {options.map((o) => {
        const on = o.key === current
        return (
          <Link
            key={o.key}
            to="."
            search={
              ((prev: DeploymentsSearch) =>
                o.key === 'map'
                  ? { ...prev, order: undefined, sel: undefined }
                  : { ...prev, order: o.key }) as never
            }
            replace
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex h-8 flex-1 items-center justify-center rounded-[7px] px-3 text-sm font-medium whitespace-nowrap no-underline',
              on
                ? 'bg-muted text-foreground'
                : 'text-foreground-2 hover:bg-[color-mix(in_oklab,var(--muted)_55%,transparent)] hover:text-foreground',
            )}
          >
            {o.label}
          </Link>
        )
      })}
    </nav>
  )
}

/** Repos no deployment runs, kept from the old table: their alerts rank last. */
function UnmappedRepos({ items }: { items: readonly DeploymentItem[] }) {
  const repos = useQuery(reposQuery)
  const mapped = new Set(items.flatMap((d) => d.repos.map((r) => r.id)))
  const unmapped = (repos.data?.items ?? []).filter((r) => !mapped.has(r.id))
  if (unmapped.length === 0) return null
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-sidebar px-3.5 py-3 text-sm">
      <IconArchive
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-foreground-2"
        stroke={1.75}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <b className="font-semibold">
          {unmapped.length} repo{unmapped.length === 1 ? ' has' : 's have'} no deployment
        </b>
        <span className="text-foreground-2">
          Their alerts rank last in All alerts. If one of them runs somewhere, map it in Settings,
          Repo mapping.
        </span>
      </span>
      <Button asChild size="sm" variant="outline">
        <Link to="/alerts" search={{ tier: ['not_deployed'] }}>
          View
        </Link>
      </Button>
    </div>
  )
}

/** The selected app's detail beside the list, read from its own query. */
function SplitDetail({ id, focused }: { id: number; focused: boolean }) {
  const query = useQuery(deploymentQuery(id))
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <EmptyState icon={IconServerOff} title="This deployment is gone">
        It dropped out of Coolify on the last scan. Pick another app from the list.
      </EmptyState>
    )
  }
  if (query.error) {
    return (
      <ErrorState
        title="This deployment did not load"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (!query.data) return <LoadingState layout="detail" label="Loading deployment" />
  return <DeploymentDetailView d={query.data} layout={focused ? 'two' : 'stack'} titleLevel={2} />
}

export function DeploymentsPage() {
  const query = useQuery(deploymentsQuery)
  const search = route.useSearch()
  const navigate = useNavigate()
  const wide = useMediaQuery(SPLIT_QUERY)
  const roomy = useMediaQuery(TAB_QUERY)
  const order: Order = search.order ?? 'server'
  // No order and no selection is the map; on a phone it is the list by server.
  const showMap = roomy && search.order === undefined && search.sel === undefined

  const title = <h1 className="text-xl font-semibold tracking-[-0.02em]">Deployments</h1>

  if (query.error) {
    return (
      <MapFrame wide={wide}>
        {title}
        <ErrorState
          title="Deployments did not load"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </MapFrame>
    )
  }
  if (!query.data) {
    return (
      <MapFrame wide={wide}>
        <LoadingState layout="table" label="Loading deployments" />
      </MapFrame>
    )
  }

  const items = query.data.items
  if (items.length === 0) {
    return (
      <MapFrame wide={wide}>
        {title}
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
      </MapFrame>
    )
  }

  const groups = groupByServer(items)
  const lists: Record<Order, DeploymentItem[]> = {
    server: groups.flatMap((g) => g.items),
    exposure: [...items].sort(byExposure),
  }
  const servers = groups.length

  if (showMap) {
    return (
      <MapFrame wide={wide}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          {title}
          <span className="text-base text-foreground-2">
            {items.length} app{items.length === 1 ? '' : 's'} on {servers} server
            {servers === 1 ? '' : 's'}
          </span>
          <div className="ml-auto w-full max-w-[340px] min-w-[260px]">
            <ViewSwitch current="map" withMap />
          </div>
        </div>
        <HeatLegend />
        <ScanStrip />
        <div data-list="" className="flex flex-col gap-6">
          {groups.map((g) => (
            <section
              key={g.server ?? SERVER_UNKNOWN}
              aria-label={g.server ?? SERVER_UNKNOWN}
              className="flex flex-col gap-2.5"
            >
              <ServerHeading group={g} />
              <ul className="m-0 grid list-none grid-cols-2 gap-2.5 p-0 desk:grid-cols-3 split:grid-cols-4">
                {g.items.map((d) => (
                  <li key={d.id} data-row="" className="flex min-w-0">
                    <Link
                      to="."
                      search={((prev: DeploymentsSearch) => ({ ...prev, sel: d.id })) as never}
                      data-row-link=""
                      className={cn(tileClass(d), 'w-full')}
                    >
                      <TileBody d={d} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <UnmappedRepos items={items} />
      </MapFrame>
    )
  }

  return (
    <SplitView
      items={lists[order]}
      getKey={(d) => d.id}
      getLabel={(d) => d.name}
      listLabel="Deployments"
      listHeader={
        <SplitListHeader
          title="Deployments"
          meta={`${items.length} app${items.length === 1 ? '' : 's'}`}
        >
          <ViewSwitch current={order} withMap={roomy} />
        </SplitListHeader>
      }
      getGroup={
        order === 'server'
          ? (d) => {
              const group = groups.find((g) => g.server === d.server)
              return {
                key: d.server ?? SERVER_UNKNOWN,
                label: <span className="font-mono">{d.server ?? SERVER_UNKNOWN}</span>,
                count: `${group?.items.length ?? 0} app${group?.items.length === 1 ? '' : 's'}`,
              }
            }
          : undefined
      }
      renderRow={(d) => <DeploymentRow d={d} />}
      renderDetail={(d, { focused }) => <SplitDetail id={d.id} focused={focused} />}
      onEscape={
        roomy
          ? () => {
              void navigate({
                to: '.',
                search: ((prev: DeploymentsSearch) => ({
                  ...prev,
                  order: undefined,
                  sel: undefined,
                })) as never,
                replace: true,
              })
              return true
            }
          : undefined
      }
    />
  )
}
