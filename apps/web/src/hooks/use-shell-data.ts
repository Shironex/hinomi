/**
 * Data the shell shows on every page: sidebar counts and the scan status.
 *
 * Placeholders until the server exposes them. Replace the bodies with TanStack Query calls
 * (see lib/queries.ts) and keep the return types, so the sidebar, tabs and top bar need no change.
 */

export interface NavCounts {
  /** Exposed findings with no snooze or accepted risk in force. Shown as the hot badge. */
  needsAction: number | null
  deployments: number | null
  alerts: number | null
  /** Fix runs not yet verified fixed. */
  activeFixRuns: number | null
}

export type ScanStatus =
  /** No source connected yet (first run). */
  | { state: 'unconfigured' }
  /** Timestamps are ISO 8601 strings. */
  | { state: 'idle'; lastScanAt: string; nextScanAt: string | null }
  | { state: 'scanning'; done: number; total: number }
  | { state: 'failed'; lastScanAt: string | null; message: string }

export const EMPTY_NAV_COUNTS: NavCounts = {
  needsAction: null,
  deployments: null,
  alerts: null,
  activeFixRuns: null,
}

export function useNavCounts(): NavCounts {
  return EMPTY_NAV_COUNTS
}

export function useScanStatus(): ScanStatus {
  return { state: 'unconfigured' }
}
