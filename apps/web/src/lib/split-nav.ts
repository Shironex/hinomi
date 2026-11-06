/**
 * The split view that owns the keyboard right now. A mounted SplitView registers itself so the
 * global shortcut handler sends j, k, Enter, Esc, f, s and a to it instead of the plain
 * DOM list navigation in list-nav.ts. Only one split view is on screen at a time.
 */
export type ListAction = 'fix' | 'snooze' | 'accept'

export interface SplitController {
  /** Selects the next or previous item. */
  move: (delta: 1 | -1) => void
  /** Enter: opens the focus view (wide) or the selected item (narrow). True when handled. */
  open: () => boolean
  /** f, s, a. True when the view handles that action. */
  action: (kind: ListAction) => boolean
  /** Esc: leaves the focus view or the narrow detail page. True when handled. */
  escape: () => boolean
}

let active: SplitController | null = null

/** Makes `controller` the active split view. Returns the cleanup. */
export function registerSplit(controller: SplitController): () => void {
  active = controller
  return () => {
    if (active === controller) active = null
  }
}

export function getActiveSplit(): SplitController | null {
  return active
}
