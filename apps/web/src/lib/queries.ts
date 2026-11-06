import { healthResponseSchema } from '@hinomi/shared'
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
}

export const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  queryFn: ({ signal }) => api.get('/health', healthResponseSchema, { signal }),
  staleTime: 15_000,
})
