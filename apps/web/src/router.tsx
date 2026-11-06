import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router'
import { AppShell } from '@/components/shell/app-shell'
import { alertsSearchSchema } from '@/lib/alerts-search'
import { NotFoundPage } from '@/routes/not-found'
import { RouteError } from '@/routes/route-error'
import { RoutePending } from '@/routes/route-pending'
import { scanStatusQuery } from '@/lib/queries'
import '@/lib/route-meta'

export interface RouterContext {
  queryClient: QueryClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
  staticData: {},
})

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // First run: with no Coolify or GitHub source the exposure view has nothing to show, so send
  // people to setup. If the status cannot be read, stay here and let the view show the error.
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient
      .fetchQuery({ ...scanStatusQuery, retry: false })
      .catch(() => null)
    // TanStack Router redirects by throwing its redirect object.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (status?.state === 'unconfigured') throw redirect({ to: '/onboarding' })
  },
  component: lazyRouteComponent(() => import('@/routes/overview'), 'OverviewPage'),
  staticData: { nav: 'overview', crumb: 'Exposure' },
})

const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/alerts',
  component: lazyRouteComponent(() => import('@/routes/alerts'), 'AlertsPage'),
  validateSearch: alertsSearchSchema,
  staticData: { nav: 'alerts', crumb: 'All alerts' },
})

const findingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/finding/$id',
  component: lazyRouteComponent(() => import('@/routes/finding-detail'), 'FindingDetailPage'),
  staticData: { nav: 'overview', crumb: 'Finding', parent: { label: 'Exposure', to: '/' } },
})

const deploymentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deployments',
  component: lazyRouteComponent(() => import('@/routes/deployments'), 'DeploymentsPage'),
  staticData: { nav: 'deployments', crumb: 'Deployments' },
})

const deploymentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deployments/$id',
  component: lazyRouteComponent(() => import('@/routes/deployment-detail'), 'DeploymentDetailPage'),
  staticData: {
    nav: 'deployments',
    crumb: 'Deployment',
    parent: { label: 'Deployments', to: '/deployments' },
  },
})

const fixRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fix-runs',
  component: lazyRouteComponent(() => import('@/routes/fix-runs'), 'FixRunsPage'),
  staticData: { nav: 'fix-runs', crumb: 'Fix runs' },
})

const driftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/drift',
  component: lazyRouteComponent(() => import('@/routes/drift'), 'DriftPage'),
  staticData: { nav: 'drift', crumb: 'Drift guards' },
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('@/routes/settings'), 'SettingsPage'),
  staticData: { nav: 'settings', crumb: 'Settings' },
})

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: lazyRouteComponent(() => import('@/routes/onboarding'), 'OnboardingPage'),
  staticData: { nav: 'onboarding', crumb: 'Set up' },
})

export const routeTree = rootRoute.addChildren([
  overviewRoute,
  alertsRoute,
  findingRoute,
  deploymentsRoute,
  deploymentRoute,
  fixRunsRoute,
  driftRoute,
  settingsRoute,
  onboardingRoute,
])

export function createAppRouter({
  queryClient,
  history,
}: {
  queryClient: QueryClient
  history?: RouterHistory
}) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultErrorComponent: RouteError,
    defaultPendingComponent: RoutePending,
    defaultPreload: 'intent',
    // Route loaders hand data to TanStack Query; let Query own freshness.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    ...(history ? { history } : {}),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
