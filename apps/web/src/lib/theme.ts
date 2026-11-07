import { useSyncExternalStore } from 'react'

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

/** Keep in sync with the inline script in index.html. */
export const THEME_STORAGE_KEY = 'hinomi:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

function readStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

function writeStoredTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage can be blocked (private mode, disabled site data). The theme still applies for this visit.
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

/** The page background of each theme, for the browser chrome. Keep in sync with index.html. */
export const THEME_COLORS = { light: '#f8f5fb', dark: '#160f1e' } as const

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  // An explicit choice can differ from the OS setting the media-split meta tags follow.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', THEME_COLORS[resolved])
  }
}

let current: Theme = readStoredTheme()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getTheme(): Theme {
  return current
}

export function setTheme(theme: Theme) {
  current = theme
  writeStoredTheme(theme)
  applyTheme(theme)
  emit()
}

/** Cycles system, light, dark (the `t` shortcut). Returns the new theme. */
export function cycleTheme(): Theme {
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length] ?? 'system'
  setTheme(next)
  return next
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Follows the OS setting while the theme is "system". Call once at startup; returns a cleanup.
 */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(DARK_QUERY)
  const onChange = () => {
    if (current === 'system') applyTheme('system')
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** Re-reads storage. Used by tests and after storage events from other tabs. */
export function syncThemeFromStorage() {
  current = readStoredTheme()
  applyTheme(current)
  emit()
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}
