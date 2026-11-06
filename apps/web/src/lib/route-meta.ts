import { useMatches } from '@tanstack/react-router'
import type { NavKey, NavPath } from '@/components/shell/nav'

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Sidebar item this route lights up. */
    nav?: NavKey
    /** Last breadcrumb. Routes with an `id` param append it. */
    crumb?: string
    /** Breadcrumb before this one, for detail routes. */
    parent?: { label: string; to: NavPath }
  }
}

export interface RouteMeta {
  nav: NavKey | undefined
  crumbs: { label: string; to?: NavPath }[]
}

/** Reads the deepest matched route's static data for the sidebar and breadcrumbs. */
export function useRouteMeta(): RouteMeta {
  const matches = useMatches()
  const match = [...matches].reverse().find((m) => m.staticData.crumb !== undefined)
  if (!match) return { nav: undefined, crumbs: [] }
  const { nav, crumb = '', parent } = match.staticData
  const params = match.params as Record<string, string | undefined>
  const label = params.id ? `${crumb} ${params.id}` : crumb
  return { nav, crumbs: parent ? [parent, { label }] : [{ label }] }
}
