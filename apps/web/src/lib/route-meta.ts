import type { FindingListItem } from '@hinomi/shared'
import { useQuery } from '@tanstack/react-query'
import { useMatches } from '@tanstack/react-router'
import type { NavKey, NavPath } from '@/components/shell/nav'
import { gapInfo } from './finding-meta'
import { deploymentQuery, findingQuery } from './view-api'

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Rail item this route lights up. */
    nav?: NavKey
    /**
     * `split` routes render a SplitView: the shell drops its padding and, from 1100 px, its top
     * bar and key bar, which the split view draws inside its detail pane instead.
     */
    layout?: 'page' | 'split'
    /** Last breadcrumb. Routes with an `id` param append it. */
    crumb?: string
    /** Breadcrumb before this one, for detail routes. */
    parent?: { label: string; to: NavPath }
  }
}

export interface RouteMeta {
  nav: NavKey | undefined
  layout: 'page' | 'split'
  crumbs: { label: string; to?: NavPath }[]
}

/** The breadcrumb name of a finding: package and advisory id, or the blind spot or note. */
export function findingCrumb(item: FindingListItem): string {
  if (item.kind !== 'advisory') return gapInfo(item)?.title ?? 'Blind spot'
  const a = item.advisory
  return a ? `${a.packageName} ${a.advisoryKey}` : 'Advisory'
}

const positiveId = (raw: string | undefined) => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Reads the deepest matched route's static data for the sidebar and breadcrumbs. Detail routes
 * name the finding or deployment from the page's own query (same cache entry, no extra call)
 * and fall back to "Finding 3" while it loads or when it does not exist.
 */
export function useRouteMeta(): RouteMeta {
  const matches = useMatches()
  const match = [...matches].reverse().find((m) => m.staticData.crumb !== undefined)
  const params = (match?.params ?? {}) as Record<string, string | undefined>
  const id = positiveId(params.id)
  const finding = useQuery({
    ...findingQuery(id),
    enabled: id > 0 && match?.routeId === '/finding/$id',
  })
  const deployment = useQuery({
    ...deploymentQuery(id),
    enabled: id > 0 && match?.routeId === '/deployments/$id',
  })
  if (!match) return { nav: undefined, layout: 'page', crumbs: [] }
  const { nav, crumb = '', parent, layout = 'page' } = match.staticData
  const name =
    match.routeId === '/finding/$id' && finding.data
      ? findingCrumb(finding.data)
      : match.routeId === '/deployments/$id' && deployment.data
        ? deployment.data.name
        : null
  const label = name ?? (params.id ? `${crumb} ${params.id}` : crumb)
  return { nav, layout, crumbs: parent ? [parent, { label }] : [{ label }] }
}
