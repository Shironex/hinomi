import {
  IconListDetails,
  IconRadar2,
  IconRobot,
  IconServer2,
  IconSettings2,
  IconShieldHalf,
  type Icon,
} from '@tabler/icons-react'
import type { NavCounts } from '@/hooks/use-shell-data'

/** Which rail item a route lights up. Detail routes point at their list. */
export type NavKey =
  'overview' | 'deployments' | 'alerts' | 'fix-runs' | 'guards' | 'settings' | 'onboarding'

export type NavPath = '/' | '/deployments' | '/alerts' | '/fix-runs' | '/guards' | '/settings'

export interface NavItem {
  key: NavKey
  to: NavPath
  label: string
  /** Label under the icon on the rail. */
  railLabel: string
  /** Label in the phone tab bar. */
  tabLabel: string
  icon: Icon
  count?: keyof NavCounts
  /** Shows the count as a badge on the icon (needs action). Other counts go in the tooltip. */
  hot?: boolean
  /** Shows the count as a quiet badge while it is not zero (fix runs in progress). */
  live?: boolean
  /** Words after the badge count for screen readers; defaults to "need action" or "running". */
  badgeNote?: string
}

export const PRIMARY_NAV: readonly NavItem[] = [
  {
    key: 'overview',
    to: '/',
    label: 'Exposure',
    railLabel: 'Exposure',
    tabLabel: 'Exposure',
    icon: IconRadar2,
    count: 'needsAction',
    hot: true,
  },
  {
    key: 'deployments',
    to: '/deployments',
    label: 'Deployments',
    railLabel: 'Deploys',
    tabLabel: 'Deploys',
    icon: IconServer2,
    count: 'deployments',
  },
  {
    key: 'alerts',
    to: '/alerts',
    label: 'All alerts',
    railLabel: 'Alerts',
    tabLabel: 'Alerts',
    icon: IconListDetails,
    count: 'alerts',
  },
  {
    key: 'fix-runs',
    to: '/fix-runs',
    label: 'Fix runs',
    railLabel: 'Fixes',
    tabLabel: 'Fixes',
    icon: IconRobot,
    count: 'activeFixRuns',
    live: true,
  },
]

export const GUARDS_NAV: NavItem = {
  key: 'guards',
  to: '/guards',
  label: 'Guards',
  railLabel: 'Guards',
  tabLabel: 'Guards',
  icon: IconShieldHalf,
  count: 'guards',
  live: true,
  badgeNote: ' failing or warning on a running app',
}

export const SETTINGS_NAV: NavItem = {
  key: 'settings',
  to: '/settings',
  label: 'Settings',
  railLabel: 'Settings',
  tabLabel: 'More',
  icon: IconSettings2,
}

/** The rail, top to bottom; settings sits apart at the bottom. */
export const RAIL_NAV: readonly NavItem[] = [...PRIMARY_NAV, GUARDS_NAV]

const countFormat = new Intl.NumberFormat('en-US')

export function formatCount(value: number | null | undefined): string | null {
  if (value == null || value === 0) return null
  return countFormat.format(value)
}
