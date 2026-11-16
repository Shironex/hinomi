/*
 * Hinomi service worker: caches the app shell only. API calls are never cached. It also shows
 * web push notifications (a "This browser" notification channel) and opens their link on a click.
 * The build (vite.config.ts) fills in BUILD_ID and PRECACHE; in dev this file is never registered.
 */
const BUILD_ID = '__BUILD_ID__'
const PRECACHE = /** @type {string[]} */ (JSON.parse('__PRECACHE__'))
const CACHE_PREFIX = 'hinomi-shell-'
const CACHE = CACHE_PREFIX + BUILD_ID

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page decides when to swap versions, so a reload never lands mid-triage.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// A push message is `{ title, body, url, tag }` (see apps/server/src/notify/outbound.ts).
self.addEventListener('push', (event) => {
  const message = readPushMessage(event)
  const title = typeof message.title === 'string' ? message.title : 'Hinomi'
  const url =
    typeof message.url === 'string' && /^https?:\/\//i.test(message.url) ? message.url : '/'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: typeof message.tag === 'string' ? message.tag : undefined,
      renotify: true,
      data: { url },
    }),
  )
})

function readPushMessage(event) {
  try {
    return (event.data && event.data.json()) || {}
  } catch {
    return {}
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const target = new URL(url, self.location.origin)
      // An open Hinomi tab goes to the finding; any other link opens a new window.
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open && target.origin === self.location.origin) {
        return open.navigate(target.href).then((w) => (w || open).focus())
      }
      return self.clients.openWindow(target.href)
    }),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Data is always live: the API goes straight to the network and is never stored.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request))
  }
})

async function networkFirstShell(request) {
  try {
    const response = await fetch(request)
    // Keep the freshest shell for offline starts. Only a real HTML page replaces it.
    const type = response.headers.get('content-type') || ''
    if (response.ok && type.includes('text/html')) {
      const cache = await caches.open(CACHE)
      await cache.put('/', response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match('/', { cacheName: CACHE })
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE })
  if (cached) return cached
  const response = await fetch(request)
  // A missing asset falls back to index.html on the server; never store that as a script or style.
  const type = response.headers.get('content-type') || ''
  if (response.ok && !type.includes('text/html')) {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  }
  return response
}
