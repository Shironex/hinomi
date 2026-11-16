import type { QueryClient } from '@tanstack/react-query'
import type { createAppRouter } from '@/router'
import { setUnauthenticatedHandler } from './api'
import { authKeys } from './auth-api'

/**
 * When the server says the session is gone (logout elsewhere, idle or absolute expiry, a revoke),
 * drop everything read with it and go to the login page, back to this page afterwards.
 */
export function installSessionGuard(
  router: ReturnType<typeof createAppRouter>,
  queryClient: QueryClient,
): void {
  setUnauthenticatedHandler(() => {
    const { pathname, href } = router.state.location
    if (pathname === '/login') return
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== authKeys.session[0] })
    void queryClient.invalidateQueries({ queryKey: authKeys.session })
    void router.navigate({ to: '/login', search: { next: href }, replace: true })
  })
}
