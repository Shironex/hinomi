/*
 * Hinomi service worker: caches the app shell only. API calls are never cached.
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
