import type { NavCountsDto, ScanStatusDto } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { navCountsQuery, queryKeys, scanStatusQuery, startScan } from '@/lib/queries'

/**
 * Data the shell shows on every page: sidebar counts and the scan status,
 * from GET /api/shell/nav-counts and /api/shell/scan-status. The types are
 * the shared API contract, so the sidebar, tabs and top bar read the same
 * shape the server validates.
 */

export type NavCounts = NavCountsDto

/** Timestamps are ISO 8601 strings. */
export type ScanStatus = ScanStatusDto

export const EMPTY_NAV_COUNTS: NavCounts = {
  needsAction: null,
  deployments: null,
  alerts: null,
  activeFixRuns: null,
}

const UNCONFIGURED: ScanStatus = { state: 'unconfigured' }

/** Counts, or nulls (no badge) while loading or when the server cannot be reached. */
export function useNavCounts(): NavCounts {
  return useQuery(navCountsQuery).data ?? EMPTY_NAV_COUNTS
}

/** Scan status. When a scan finishes, every other query is refreshed to show its results. */
export function useScanStatus(): ScanStatus {
  const queryClient = useQueryClient()
  const status = useQuery(scanStatusQuery).data ?? UNCONFIGURED
  const previous = useRef(status.state)
  useEffect(() => {
    if (previous.current === 'scanning' && status.state !== 'scanning') {
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.scanStatus[0],
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.navCounts })
    }
    previous.current = status.state
  }, [queryClient, status.state])
  return status
}

/** Handler for the "Scan now" button; undefined while a start request is in flight. */
export function useStartScan(): (() => void) | undefined {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: startScan,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.scanStatus }),
  })
  return mutation.isPending ? undefined : () => mutation.mutate()
}
