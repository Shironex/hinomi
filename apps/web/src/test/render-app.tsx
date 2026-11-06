import { render } from '@testing-library/react'
import { createMemoryHistory } from '@tanstack/react-router'
import { App } from '@/App'
import { createQueryClient } from '@/lib/queries'
import { createAppRouter } from '@/router'

/** Renders the whole app (shell, router, query client) at `path`. */
export async function renderApp(path = '/') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  const utils = render(<App queryClient={queryClient} router={router} />)
  return { ...utils, router, queryClient }
}
