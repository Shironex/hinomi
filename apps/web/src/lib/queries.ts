import {
  healthResponseSchema,
  navCountsSchema,
  scanStatusSchema,
  startScanResponseSchema,
} from '@hinomi/shared'
import { QueryClient, queryOptions } from '@tanstack/react-query'
import { api, ApiError } from './api'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Retrying a 4xx or a contract mismatch never helps; retry network blips twice.
        retry: (failureCount, error) =>
          failureCount < 2 &&
          !(error instanceof ApiError && (error.kind === 'parse' || (error.status ?? 500) < 500)),
      },
    },
  })
}

export const queryKeys = {
  health: ['health'] as const,
  navCounts: ['shell', 'nav-counts'] as const,
  scanStatus: ['shell', 'scan-status'] as const,
}

export const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  queryFn: ({ signal }) => api.get('/health', healthResponseSchema, { signal }),
  staleTime: 15_000,
})

/** Poll fast while a scan runs so the progress moves, slowly otherwise. */
export const SCAN_POLL_ACTIVE_MS = 3_000
export const SHELL_POLL_IDLE_MS = 60_000

export const navCountsQuery = queryOptions({
  queryKey: queryKeys.navCounts,
  queryFn: ({ signal }) => api.get('/shell/nav-counts', navCountsSchema, { signal }),
  refetchInterval: SHELL_POLL_IDLE_MS,
})

export const scanStatusQuery = queryOptions({
  queryKey: queryKeys.scanStatus,
  queryFn: ({ signal }) => api.get('/shell/scan-status', scanStatusSchema, { signal }),
  staleTime: 5_000,
  refetchInterval: (query) =>
    query.state.data?.state === 'scanning' ? SCAN_POLL_ACTIVE_MS : SHELL_POLL_IDLE_MS,
})

/** Starts a scan; when one is already running the server returns that one. */
export function startScan() {
  return api.post('/scans', startScanResponseSchema)
}
