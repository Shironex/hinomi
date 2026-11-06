import type { ListAction } from './split-nav'

/** Views reachable with `g` then a letter. */
export const GO_TO = {
  e: '/',
  d: '/deployments',
  a: '/alerts',
  f: '/fix-runs',
  s: '/settings',
} as const

export type GoToPath = (typeof GO_TO)[keyof typeof GO_TO]

/** The list shown in the shortcuts dialog, in display order. */
export const SHORTCUT_HELP: readonly { label: string; keys: readonly string[] }[] = [
  { label: 'Move down, up', keys: ['j', 'k'] },
  { label: 'Open selected, or the focus view', keys: ['Enter'] },
  { label: 'Back to the list', keys: ['Esc'] },
  { label: 'Run the fix agent', keys: ['f'] },
  { label: 'Snooze', keys: ['s'] },
  { label: 'Accept the risk', keys: ['a'] },
  { label: 'Go to exposure', keys: ['g', 'e'] },
  { label: 'Go to deployments', keys: ['g', 'd'] },
  { label: 'Go to all alerts', keys: ['g', 'a'] },
  { label: 'Go to fix runs', keys: ['g', 'f'] },
  { label: 'Go to settings', keys: ['g', 's'] },
  { label: 'Search alerts', keys: ['/'] },
  { label: 'Switch theme', keys: ['t'] },
  { label: 'Show this list', keys: ['?'] },
]

export interface ShortcutActions {
  navigate: (to: GoToPath) => void
  toggleTheme: () => void
  toggleHelp: () => void
  focusSearch: () => void
  moveSelection: (delta: 1 | -1) => void
  /** Returns true when a selected row was opened. */
  openSelection: () => boolean
  /** f, s, a on the selected item of a split view. */
  listAction: (kind: ListAction) => void
  /** Returns true when Esc closed something (focus view, narrow detail). */
  escape: () => boolean
  /** While a dialog is open only `?` (close help) is handled; the dialog owns the rest. */
  isDialogOpen: () => boolean
}

/** How long `g` waits for the second key. */
export const CHORD_TIMEOUT_MS = 900

/** True when the event comes from a place where keys are text, not commands. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type)
  }
  return target.getAttribute('role') === 'textbox'
}

function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('a[href], button, summary, [role="button"], [role="link"]') !== null
  )
}

/**
 * Builds the global keydown handler. Pure apart from the injected actions and a chord timer,
 * so it can be unit tested without a router or DOM layout.
 */
export function createShortcutHandler(actions: ShortcutActions) {
  let chordPending = false
  let chordTimer: ReturnType<typeof setTimeout> | undefined

  const endChord = () => {
    chordPending = false
    if (chordTimer !== undefined) clearTimeout(chordTimer)
    chordTimer = undefined
  }

  return function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (isTypingTarget(event.target)) return

    if (actions.isDialogOpen()) {
      if (event.key === '?') {
        event.preventDefault()
        actions.toggleHelp()
      }
      return
    }

    if (chordPending) {
      endChord()
      const to = GO_TO[event.key as keyof typeof GO_TO] as GoToPath | undefined
      if (to) {
        event.preventDefault()
        actions.navigate(to)
      }
      return
    }

    switch (event.key) {
      case 'g':
        chordPending = true
        chordTimer = setTimeout(endChord, CHORD_TIMEOUT_MS)
        return
      case '?':
        event.preventDefault()
        actions.toggleHelp()
        return
      case 't':
        actions.toggleTheme()
        return
      case '/':
        event.preventDefault()
        actions.focusSearch()
        return
      case 'j':
        event.preventDefault()
        actions.moveSelection(1)
        return
      case 'k':
        event.preventDefault()
        actions.moveSelection(-1)
        return
      case 'f':
        actions.listAction('fix')
        return
      case 's':
        actions.listAction('snooze')
        return
      case 'a':
        actions.listAction('accept')
        return
      case 'Escape':
        if (actions.escape()) event.preventDefault()
        return
      case 'Enter':
        // A focused link or button already handles Enter natively; opening the row too would double fire.
        if (isActivatable(event.target)) return
        if (actions.openSelection()) event.preventDefault()
        return
    }
  }
}
