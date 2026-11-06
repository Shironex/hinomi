import { useCallback, useEffect, useState } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useNavCounts, useScanStatus, useStartScan } from '@/hooks/use-shell-data'
import { useShortcuts } from '@/hooks/use-shortcuts'
import { clearListSelection, moveListSelection, openListSelection } from '@/lib/list-nav'
import { useRouteMeta } from '@/lib/route-meta'
import { findSearchInput, focusSearchInput } from '@/lib/search'
import { cycleTheme } from '@/lib/theme'
import { MobileTabs } from './mobile-tabs'
import { ShortcutsDialog } from './shortcuts-dialog'
import { Sidebar } from './sidebar'
import { THEME_LABEL } from './theme-meta'
import { TopBar } from './top-bar'

export function AppShell() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const meta = useRouteMeta()
  const counts = useNavCounts()
  const scan = useScanStatus()
  const startScan = useStartScan()
  const [helpOpen, setHelpOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  // A fresh view starts with no keyboard selection.
  useEffect(() => clearListSelection(), [pathname])

  const focusSearch = useCallback(() => {
    if (findSearchInput()) {
      focusSearchInput()
      return
    }
    void navigate({ to: '/alerts' }).then(() => focusSearchInput())
  }, [navigate])

  useShortcuts({
    navigate: (to) => void navigate({ to }),
    toggleTheme: () => setAnnouncement(`Theme: ${THEME_LABEL[cycleTheme()]}`),
    toggleHelp: () => setHelpOpen((open) => !open),
    focusSearch,
    moveSelection: (delta) => moveListSelection(delta),
    openSelection: () => openListSelection(),
    isDialogOpen: () => helpOpen || document.querySelector('[role="dialog"]') !== null,
  })

  return (
    <div className="grid min-h-svh grid-cols-[minmax(0,1fr)] tab:grid-cols-[60px_minmax(0,1fr)] desk:grid-cols-[232px_minmax(0,1fr)]">
      <a
        href="#main"
        className="fixed top-2 left-2 z-50 -translate-y-16 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus-visible:translate-y-0"
      >
        Skip to content
      </a>
      <Sidebar
        current={meta.nav}
        counts={counts}
        scan={scan}
        onOpenHelp={() => setHelpOpen(true)}
      />
      <div className="flex min-w-0 flex-col">
        <TopBar crumbs={meta.crumbs} scan={scan} onSearch={focusSearch} onScan={startScan} />
        <main
          id="main"
          tabIndex={-1}
          className="w-full max-w-[1280px] pt-6 pr-[max(16px,env(safe-area-inset-right))] pb-[calc(88px+env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] outline-none tab:pr-[max(24px,env(safe-area-inset-right))] tab:pb-16 tab:pl-[max(24px,env(safe-area-inset-left))]"
        >
          <Outlet />
        </main>
      </div>
      <MobileTabs current={meta.nav} needsAction={counts.needsAction} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
