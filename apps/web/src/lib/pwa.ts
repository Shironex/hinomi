import { useSyncExternalStore } from 'react'

/** Where the service worker lives. The server serves it from the root so its scope is the app. */
export const SERVICE_WORKER_URL = '/sw.js'

/**
 * Whether to register the service worker: production builds only, in a secure context (HTTPS or
 * localhost), and only where the browser has the API. Never in dev, where it would cache modules.
 */
export function canRegisterServiceWorker(): boolean {
  return (
    import.meta.env.PROD &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator
  )
}

let waiting: ServiceWorker | null = null
const listeners = new Set<() => void>()

function setWaiting(worker: ServiceWorker | null) {
  waiting = worker
  for (const listener of listeners) listener()
}

/** The new version waits only when an older one already controls the page (not on first install). */
function trackWaiting(registration: ServiceWorkerRegistration) {
  const check = () => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      setWaiting(registration.waiting)
    }
  }
  check()
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') check()
    })
  })
}

/** Registers the service worker when allowed. Returns whether it tried. */
export function registerServiceWorker(): boolean {
  if (!canRegisterServiceWorker()) return false
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: '/' })
      .then(trackWaiting)
      .catch(() => {
        // The app works without it; offline start-up is just not available.
      })
  })
  return true
}

/** Swaps to the waiting version and reloads once it takes over. Called only on the user's click. */
export function applyServiceWorkerUpdate() {
  if (!waiting) return
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
    once: true,
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True while a new version is downloaded and waiting for the user to reload. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => waiting !== null,
    () => false,
  )
}

/** Test hook: pretend a new version is waiting. */
export function setUpdateWaitingForTest(worker: ServiceWorker | null) {
  setWaiting(worker)
}
