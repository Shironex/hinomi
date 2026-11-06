/** Views mark their search field with this attribute so `/` and the top bar trigger can find it. */
export const SEARCH_INPUT_SELECTOR = '[data-search-input]'

export function findSearchInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SEARCH_INPUT_SELECTOR)
}

/** Focuses the search field, waiting a few frames for a view that is still mounting. */
export function focusSearchInput(frames = 20): void {
  const input = findSearchInput()
  if (input) {
    input.focus()
    return
  }
  if (frames > 0) requestAnimationFrame(() => focusSearchInput(frames - 1))
}
