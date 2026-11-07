import { useCallback, useEffect, useState } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import { useNavCounts, useScanStatus, useStartScan } from '@/hooks/use-shell-data'
import { useShortcuts } from '@/hooks/use-shortcuts'
import { clearListSelection, moveListSelection, openListSelection } from '@/lib/list-nav'
import { useRouteMeta } from '@/lib/route-meta'
import { findSearchInput, focusSearchInput } from '@/lib/search'
import { getActiveSplit } from '@/lib/split-nav'
import { cycleTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { OfflineBanner } from '@/components/states/offline-banner'
import { FixDialog } from '@/components/views/fix-dialog'
import { PublicAccessBanner } from './access-status'
import { IconRail } from './icon-rail'
import { KeyHintBar } from './key-hint-bar'
import { PAGE_KEY_HINTS } from './key-hints-meta'
import { MobileTabs } from './mobile-tabs'
import { ShellContext, type ShellState } from './shell-context'
import { ShortcutsDialog } from './shortcuts-dialog'
import { THEME_LABEL } from './theme-meta'
import { TopBar } from './top-bar'
import { UpdatePrompt } from './update-prompt'

export function AppShell() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const meta = useRouteMeta()
  const counts = useNavCounts()
  const scan = useScanStatus()
  const startScan = useStartScan()
  const wide = useMediaQuery(SPLIT_QUERY)
  const [helpOpen, setHelpOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const openHelp = useCallback(() => setHelpOpen(true), [])

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
    // A split view, when one is mounted, owns the list keys; other views use the DOM list.
    moveSelection: (delta) => {
      const split = getActiveSplit()
      if (split) split.move(delta)
      else moveListSelection(delta)
    },
    openSelection: () => getActiveSplit()?.open() ?? openListSelection(),
    listAction: (kind) => void getActiveSplit()?.action(kind),
    escape: () => getActiveSplit()?.escape() ?? false,
    isDialogOpen: () => helpOpen || document.querySelector('[role="dialog"]') !== null,
  })

  const shell: ShellState = { meta, counts, scan, startScan, openHelp }
  const dialogs = (
    <>
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <FixDialog />
      <UpdatePrompt />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  )

  if (meta.layout === 'setup') {
    // First run: the setup page draws its own steps pane; no rail, bars or tabs to wander off to.
    return (
      <ShellContext.Provider value={shell}>
        <div className="flex min-h-svh flex-col">
          <PublicAccessBanner />
          <OfflineBanner />
          <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
            <Outlet />
          </main>
          {dialogs}
        </div>
      </ShellContext.Provider>
    )
  }

  const split = meta.layout === 'split'
  // From 1100 px a split view draws the top bar and key bar inside its detail pane.
  const splitWide = split && wide

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex min-h-svh">
        <a
          href="#main"
          className="fixed top-2 left-2 z-50 -translate-y-16 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground focus-visible:translate-y-0"
        >
          Skip to content
        </a>
        <IconRail current={meta.nav} counts={counts} scan={scan} />
        <div className={cn('flex min-w-0 flex-1 flex-col', splitWide && 'h-dvh')}>
          {splitWide ? null : <TopBar className={split ? undefined : 'sticky top-0 z-10'} />}
          <PublicAccessBanner />
          <OfflineBanner />
          <main
            id="main"
            tabIndex={-1}
            className={cn(
              'flex min-h-0 w-full flex-1 flex-col outline-none',
              split
                ? 'pb-[calc(72px+env(safe-area-inset-bottom))] tab:pb-0'
                : 'max-w-[1280px] pt-6 pr-[max(16px,env(safe-area-inset-right))] pb-[calc(96px+env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] tab:px-8 tab:pt-7 tab:pb-16',
            )}
          >
            <Outlet />
          </main>
          {split ? null : <KeyHintBar hints={PAGE_KEY_HINTS} className="sticky bottom-0 z-10" />}
        </div>
        <MobileTabs current={meta.nav} needsAction={counts.needsAction} />
        {dialogs}
      </div>
    </ShellContext.Provider>
  )
}
