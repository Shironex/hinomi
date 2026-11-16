import { canRegisterServiceWorker } from './pwa'

// Subscribes this browser to web push for a "This browser" notification channel. Push needs the
// service worker, so it works in the installed build over HTTPS (or on localhost), never in dev.

/** Why this browser cannot get push notifications, or null when it can try. */
export function webPushProblem(): string | null {
  if (typeof window === 'undefined' || !('PushManager' in window) || !('Notification' in window)) {
    return 'This browser does not support push notifications.'
  }
  if (!canRegisterServiceWorker()) {
    return 'Push notifications need the built app served over HTTPS (or localhost), where the service worker runs.'
  }
  if (Notification.permission === 'denied') {
    return 'Notifications are blocked for this site. Allow them in the browser settings first.'
  }
  return null
}

/** What a web push channel is created with: the endpoint and `<p256dh>.<auth>`. */
export interface BrowserSubscription {
  url: string
  secret: string
}

const READY_TIMEOUT_MS = 10_000

/**
 * Asks for permission, then subscribes with the server's VAPID key (or reuses this browser's
 * subscription). Throws an Error with a message to show when anything is missing.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<BrowserSubscription> {
  const problem = webPushProblem()
  if (problem) throw new Error(problem)
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notifications were not allowed, so this browser cannot be added.')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('The service worker is not running yet. Reload and try again.')),
        READY_TIMEOUT_MS,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  const subscription = await currentSubscription(registration.pushManager, publicKey)
  const json = subscription.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error('The browser returned an incomplete push subscription.')
  }
  // The key it was made under goes along, so the server can refuse one under a replaced key.
  return { url: json.endpoint, secret: `${p256dh}.${auth}.${publicKey}` }
}

/**
 * This browser's subscription under `publicKey`. One made under another key (Hinomi replaced its
 * key after HINOMI_SECRET_KEY changed) can never be delivered to: it is dropped and replaced.
 */
export async function currentSubscription(
  pushManager: PushManager,
  publicKey: string,
): Promise<PushSubscription> {
  const key = base64UrlToBytes(publicKey)
  const existing = await pushManager.getSubscription()
  if (existing && sameKey(existing.options.applicationServerKey, key)) return existing
  if (existing) await existing.unsubscribe()
  return pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!current) return false
  const bytes = new Uint8Array(current)
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i])
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
