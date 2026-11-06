import { createContext, useContext } from 'react'
import type { NavCounts, ScanStatus } from '@/hooks/use-shell-data'
import type { RouteMeta } from '@/lib/route-meta'

/**
 * What the shell reads once and shares with every piece of chrome, including the top bar a
 * split view draws inside its detail pane. Reading the scan status once matters: its hook
 * refreshes every query when a scan ends, and two readers would do that twice.
 */
export interface ShellState {
  meta: RouteMeta
  counts: NavCounts
  scan: ScanStatus
  /** Starts a scan; undefined while a start request is in flight. */
  startScan: (() => void) | undefined
  openHelp: () => void
}

export const ShellContext = createContext<ShellState | null>(null)

export function useShell(): ShellState {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error('useShell needs the AppShell around it')
  return shell
}
