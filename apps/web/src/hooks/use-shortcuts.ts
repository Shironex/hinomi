import { useEffect, useRef } from 'react'
import { createShortcutHandler, type ShortcutActions } from '@/lib/shortcuts'

/** Installs the global shortcut handler once; always calls the latest actions. */
export function useShortcuts(actions: ShortcutActions) {
  const latest = useRef(actions)
  useEffect(() => {
    latest.current = actions
  })

  useEffect(() => {
    const handler = createShortcutHandler({
      navigate: (to) => latest.current.navigate(to),
      toggleTheme: () => latest.current.toggleTheme(),
      toggleHelp: () => latest.current.toggleHelp(),
      focusSearch: () => latest.current.focusSearch(),
      moveSelection: (delta) => latest.current.moveSelection(delta),
      openSelection: () => latest.current.openSelection(),
      isDialogOpen: () => latest.current.isDialogOpen(),
    })
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])
}
