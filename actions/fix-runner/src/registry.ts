import { nowMs } from '@hinomi/shared'
import type { Npmrc } from './npmrc.js'

// Publish times from the npm registry (the `time` map of a package document), the crates.io
// API (`created_at` of a version), the Go module proxy (`Time` of a version's .info), PyPI
// (the earliest `upload_time_iso_8601` of a release's files) and Packagist (`time` of a
// version in the p2 metadata). The apply job has no secrets, so only public
// metadata is read and nothing is sent but the package name and version.

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

/** Base of the crates.io API; a Cargo applier passes it as the registry. */
export const CRATES_IO_API = 'https://crates.io/api/v1/crates/'

/** crates.io asks API clients to name themselves and how to reach the maintainers. */
export const CRATES_IO_USER_AGENT = 'hinomi-fix-runner (https://github.com/Shironex/hinomi)'

export interface CratesOptions {
  /** Least time between two requests; crates.io's crawler policy asks for one per second. */
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** crates.io lookups, one request per crate version and run, one at a time and spaced out. */
export function cratesPublishTimes(
  fetchImpl: HttpFetch,
  options: CratesOptions = {},
): PublishTimes {
  const intervalMs = options.intervalMs ?? 1_000
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = options.now ?? nowMs
  const cache = new Map<string, Promise<Date | null>>()
  let queue: Promise<unknown> = Promise.resolve()
  let last = Number.NEGATIVE_INFINITY
  const lookup = async (url: string): Promise<Date | null> => {
    const wait = last + intervalMs - now()
    if (wait > 0) await sleep(wait)
    last = now()
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': CRATES_IO_USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) return null
      const body = (await response.json()) as { version?: { created_at?: unknown } } | null
      const value = body?.version?.created_at
      if (typeof value !== 'string') return null
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? null : date
    } catch {
      return null
    }
  }
  return {
    publishedAt(crateName, version) {
      const url = `${CRATES_IO_API}${encodeURIComponent(crateName)}/${encodeURIComponent(version)}`
      let pending = cache.get(url)
      if (!pending) {
        pending = queue.then(() => lookup(url))
        queue = pending
        cache.set(url, pending)
      }
      return pending
    },
  }
}

/** The public Go module proxy; a Go applier passes it as the registry. */
export const GO_PROXY = 'https://proxy.golang.org/'
/** PyPI's JSON API; the uv and pip appliers pass it as the registry. */
export const PYPI_API = 'https://pypi.org/pypi/'
/** Packagist's p2 metadata; the composer applier passes it as the registry. */
export const PACKAGIST_API = 'https://repo.packagist.org/p2/'

const toDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** One cached JSON document per URL and run; null for any failure. */
function jsonDocuments(fetchImpl: HttpFetch) {
  const cache = new Map<string, Promise<unknown>>()
  return (url: string): Promise<unknown> => {
    let pending = cache.get(url)
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetchImpl(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
          return response.ok ? await response.json() : null
        } catch {
          return null
        }
      })()
      cache.set(url, pending)
    }
    return pending
  }
}

/** The proxy's case encoding of a module path or version: `!` before each lowercased capital. */
export function goProxyEscape(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`)
}

/** Go proxy lookups: `<module>/@v/v<version>.info`, whose `Time` is the publish time. */
export function goPublishTimes(fetchImpl: HttpFetch): PublishTimes {
  const document = jsonDocuments(fetchImpl)
  return {
    async publishedAt(modulePath, version) {
      const url = `${GO_PROXY}${goProxyEscape(modulePath)}/@v/${goProxyEscape(`v${version}`)}.info`
      const body = (await document(url)) as { Time?: unknown } | null
      return toDate(body?.Time)
    },
  }
}

/** PyPI lookups: `<name>/<version>/json`, the earliest upload among the release's files. */
export function pypiPublishTimes(fetchImpl: HttpFetch): PublishTimes {
  const document = jsonDocuments(fetchImpl)
  return {
    async publishedAt(packageName, version) {
      const url = `${PYPI_API}${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`
      const body = (await document(url)) as { urls?: unknown } | null
      if (!Array.isArray(body?.urls)) return null
      const times = body.urls
        .map((file) => toDate((file as { upload_time_iso_8601?: unknown }).upload_time_iso_8601))
        .filter((date): date is Date => date !== null)
        .sort((a, b) => a.getTime() - b.getTime())
      return times[0] ?? null
    },
  }
}

/** Packagist lookups: `<vendor>/<package>.json`, the `time` of the version (a `v` prefix too). */
export function packagistPublishTimes(fetchImpl: HttpFetch): PublishTimes {
  const document = jsonDocuments(fetchImpl)
  return {
    async publishedAt(packageName, version) {
      const [vendor, name] = packageName.split('/')
      if (!vendor || !name) return null
      const url = `${PACKAGIST_API}${encodeURIComponent(vendor)}/${encodeURIComponent(name)}.json`
      const body = (await document(url)) as { packages?: Record<string, unknown> } | null
      const versions = body?.packages?.[packageName]
      if (!Array.isArray(versions)) return null
      const entry = versions.find((item) => {
        const v = (item as { version?: unknown }).version
        return typeof v === 'string' && v.replace(/^v(?=\d)/i, '') === version
      }) as { time?: unknown } | undefined
      return toDate(entry?.time)
    },
  }
}

/** Publish times of every ecosystem, picked by the registry the applier passes. */
export function registryPublishTimes(fetchImpl: HttpFetch): PublishTimes {
  const npm = npmPublishTimes(fetchImpl)
  const byRegistry = new Map<string, PublishTimes>([
    [CRATES_IO_API, cratesPublishTimes(fetchImpl)],
    [GO_PROXY, goPublishTimes(fetchImpl)],
    [PYPI_API, pypiPublishTimes(fetchImpl)],
    [PACKAGIST_API, packagistPublishTimes(fetchImpl)],
  ])
  return {
    publishedAt(packageName, version, registry) {
      const source = byRegistry.get(registry) ?? npm
      return source.publishedAt(packageName, version, registry)
    },
  }
}
