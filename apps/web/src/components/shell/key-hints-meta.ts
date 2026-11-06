export interface KeyHint {
  keys: readonly string[]
  label: string
}

/** Hints on page routes: plain list navigation. Split views pass their own set. */
export const PAGE_KEY_HINTS: readonly KeyHint[] = [
  { keys: ['j', 'k'], label: 'move' },
  { keys: ['Enter'], label: 'open' },
  { keys: ['/'], label: 'search' },
  { keys: ['g'], label: 'go to' },
]
