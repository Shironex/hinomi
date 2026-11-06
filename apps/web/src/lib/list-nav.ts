/**
 * j/k list navigation over the DOM, so any view opts in with two attributes:
 * mark the list container `data-list` and each row `data-row`. The row's primary link is the
 * element with `data-row-link`, or else its first link or button. Moving focuses that element,
 * so screen readers follow along and Enter opens it natively.
 */
const ROW_SELECTOR = '[data-list] [data-row]'
const ACTIVE_ATTR = 'data-kb'

function rows(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ROW_SELECTOR))
}

function primaryTarget(row: HTMLElement): HTMLElement | null {
  return (
    row.querySelector<HTMLElement>('[data-row-link]') ??
    row.querySelector<HTMLElement>('a[href], button:not([disabled])')
  )
}

export function activeRowIndex(root: ParentNode = document): number {
  return rows(root).findIndex((row) => row.hasAttribute(ACTIVE_ATTR))
}

/** Moves the keyboard selection by `delta` rows. Returns the new index, or -1 with no rows. */
export function moveListSelection(delta: number, root: ParentNode = document): number {
  const all = rows(root)
  if (all.length === 0) return -1
  const from = all.findIndex((row) => row.hasAttribute(ACTIVE_ATTR))
  const next =
    from === -1
      ? delta > 0
        ? 0
        : all.length - 1
      : Math.max(0, Math.min(all.length - 1, from + delta))
  all.forEach((row, i) => row.toggleAttribute(ACTIVE_ATTR, i === next))
  const row = all[next]
  if (row) {
    row.scrollIntoView?.({ block: 'nearest' })
    ;(primaryTarget(row) ?? row).focus({ preventScroll: true })
  }
  return next
}

/** Opens the selected row. Returns false when nothing is selected. */
export function openListSelection(root: ParentNode = document): boolean {
  const row = rows(root).find((r) => r.hasAttribute(ACTIVE_ATTR))
  if (!row) return false
  ;(primaryTarget(row) ?? row).click()
  return true
}

export function clearListSelection(root: ParentNode = document) {
  for (const row of rows(root)) row.removeAttribute(ACTIVE_ATTR)
}
