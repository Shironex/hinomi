import {
  IconListDetails,
  IconRadar2,
  IconRobot,
  IconRouteAltLeft,
  IconServer2,
  IconSettings2,
  type Icon,
} from '@tabler/icons-react'
import type { NavCounts } from '@/hooks/use-shell-data'

/** Which sidebar item a route lights up. Detail routes point at their list. */
export type NavKey =
  'overview' | 'deployments' | 'alerts' | 'fix-runs' | 'drift' | 'settings' | 'onboarding'

export type NavPath = '/' | '/deployments' | '/alerts' | '/fix-runs' | '/drift' | '/settings'

export interface NavItem {
  key: NavKey
  to: NavPath
  label: string
  /** Shorter label for the phone tab bar. */
  tabLabel: string
  icon: Icon
  count?: keyof NavCounts
  /** Shows the count in the critical color (needs action). */
  hot?: boolean
}

export const PRIMARY_NAV: readonly NavItem[] = [
  {
    key: 'overview',
    to: '/',
    label: 'Exposure',
    tabLabel: 'Exposure',
    icon: IconRadar2,
    count: 'needsAction',
    hot: true,
  },
  {
    key: 'deployments',
    to: '/deployments',
    label: 'Deployments',
    tabLabel: 'Deploys',
    icon: IconServer2,
    count: 'deployments',
  },
  {
    key: 'alerts',
    to: '/alerts',
    label: 'All alerts',
    tabLabel: 'Alerts',
    icon: IconListDetails,
    count: 'alerts',
  },
  {
    key: 'fix-runs',
    to: '/fix-runs',
    label: 'Fix runs',
    tabLabel: 'Fixes',
    icon: IconRobot,
    count: 'activeFixRuns',
  },
]

export const DRIFT_NAV: NavItem = {
  key: 'drift',
  to: '/drift',
  label: 'Drift guards',
  tabLabel: 'Drift',
  icon: IconRouteAltLeft,
}

export const SETTINGS_NAV: NavItem = {
  key: 'settings',
  to: '/settings',
  label: 'Settings',
  tabLabel: 'More',
  icon: IconSettings2,
}

const countFormat = new Intl.NumberFormat('en-US')

export function formatCount(value: number | null | undefined): string | null {
  if (value == null || value === 0) return null
  return countFormat.format(value)
}
