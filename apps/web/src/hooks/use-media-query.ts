import { useCallback, useSyncExternalStore } from 'react'

/** Wide enough for the list and the detail side by side (the `split:` breakpoint, 1100 px). */
export const SPLIT_QUERY = '(min-width: 68.75rem)'

/** Past the phone: the icon rail instead of bottom tabs (the `tab:` breakpoint, 761 px). */
export const TAB_QUERY = '(min-width: 47.5625rem)'

/**
 * Whether `query` matches, kept live. Where matchMedia does not exist (jsdom in tests) it
 * returns `fallback`.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const media = window.matchMedia(query)
      media.addEventListener?.('change', onChange)
      return () => media.removeEventListener?.('change', onChange)
    },
    [query],
  )
  const read = () =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback
  return useSyncExternalStore(subscribe, read, () => fallback)
}
