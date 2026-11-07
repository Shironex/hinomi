import type { Npmrc } from './npmrc.js'

// Publish times from the npm registry: the `time` map of a package document. The apply job
// has no secrets, so only public metadata is read and nothing is sent but the package name.

export type HttpFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const TIMEOUT_MS = 20_000

/** True for an https registry, or plain http on a loopback host. */
function usableRegistry(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return (
      parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    )
  } catch {
    return false
  }
}

/** The registry a package resolves from: its scope's registry, the default one, or npmjs. */
export function registryFor(packageName: string, npmrcs: Npmrc[]): string {
  const scope = packageName.startsWith('@') ? packageName.slice(0, packageName.indexOf('/')) : null
  for (const rc of npmrcs) {
    const url = (scope && rc.values.get(`${scope}:registry`)) || rc.values.get('registry')
    if (url && usableRegistry(url)) return url.endsWith('/') ? url : `${url}/`
  }
  return DEFAULT_REGISTRY
}

export interface PublishTimes {
  /** When `version` of `packageName` was published, null when the registry does not say. */
  publishedAt(packageName: string, version: string, registry: string): Promise<Date | null>
}

/** Registry lookups with one request per package and run. */
export function npmPublishTimes(fetchImpl: HttpFetch): PublishTimes {
  const cache = new Map<string, Promise<Record<string, unknown> | null>>()
  const document = (packageName: string, registry: string) => {
    const url = registry + packageName.replace('/', '%2f')
    let pending = cache.get(url)
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetchImpl(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
          if (!response.ok) return null
          const body = await response.json()
          const time =
            typeof body === 'object' && body !== null ? (body as { time?: unknown }).time : null
          return typeof time === 'object' && time !== null
            ? (time as Record<string, unknown>)
            : null
        } catch {
          return null
        }
      })()
      cache.set(url, pending)
    }
    return pending
  }
  return {
    async publishedAt(packageName, version, registry) {
      const time = await document(packageName, registry)
      const value = time?.[version]
      if (typeof value !== 'string') return null
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? null : date
    },
  }
}
