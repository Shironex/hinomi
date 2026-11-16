import { Outlet, useMatches } from '@tanstack/react-router'
import { AppShell } from './app-shell'

/**
 * The login page renders alone: the shell reads scan state, counts and the access status, all of
 * which need a session. Every other route gets the shell.
 */
export function RootLayout() {
  const auth = useMatches({
    select: (matches) => matches.some((m) => m.staticData.layout === 'auth'),
  })
  if (!auth) return <AppShell />
  return (
    <main id="main" tabIndex={-1} className="flex min-h-svh flex-col outline-none">
      <Outlet />
    </main>
  )
}
