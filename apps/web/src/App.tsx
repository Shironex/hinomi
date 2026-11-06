import type { QueryClient } from '@tanstack/react-query'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { ErrorBoundary } from '@/components/states/error-boundary'
import type { createAppRouter } from '@/router'

interface AppProps {
  queryClient: QueryClient
  router: ReturnType<typeof createAppRouter>
}

export function App({ queryClient, router }: AppProps) {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
