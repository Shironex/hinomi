import { gunzipSync, gzipSync } from 'node:zlib'
import {
  RUNTIMES,
  RUNTIME_PRODUCTS,
  SUPPORT_STALE_AFTER_DAYS,
  currentTime,
  type SupportDataSource,
  type SupportStatus,
} from '@hinomi/shared'
import { silentLogger, type Logger } from '../log.js'
import type { HttpCacheRepository } from '../repository/index.js'
import { fetchProductsFull, type FetchResult } from './client.js'
import { createSupportIndex, supportBasisOf, type SupportIndex } from './lookup.js'
import { parseProductsFull, type ParsedSupportData } from './products.js'

/** The `http_cache` key of the `products/full` answer. */
export const PRODUCTS_FULL_KEY = 'eol:products-full'

/** One check a day (Q11). */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** While nothing needs the data, the job looks again this often. */
export const IDLE_RECHECK_MS = 60 * 60 * 1000
const RETRY_BASE_MS = 30 * 60 * 1000
const RETRY_MAX_MS = 6 * 60 * 60 * 1000
const MIN_DELAY_MS = 60 * 1000

export type RefreshOutcome =
  { kind: 'updated' | 'not_modified' } | { kind: 'failed'; reason: string; retryAfterMs?: number }

export interface SupportData {
  /** The lookups over the newest copy; null until a copy exists (fresh install, no network yet). */
  index(): SupportIndex | null
  status(): SupportStatus
  /** Asks endoflife.date now (a conditional request). Never throws; concurrent calls share one. */
  refresh(): Promise<RefreshOutcome>
  /**
   * One round of the daily job: refreshes when the copy is a day old and something needs it,
   * and says when to come back.
   */
  tick(): Promise<{ nextDelayMs: number }>
}

export interface SupportDataOptions {
  cache: HttpCacheRepository
  fetch?: typeof fetch
  log?: Logger
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /**
   * Whether anything needs the data (a repo with a runtime pin or a matching framework). While
   * it says no, nothing is fetched. A copy that already exists is still loaded and served.
   */
  demand?: () => boolean
  /** Replaces the endoflife.date address (tests). */
  baseUrl?: string
}

function compress(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'))
}

function readStored(body: Buffer): ParsedSupportData {
  return parseProductsFull(gunzipSync(body).toString('utf8'))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The endoflife.date data Hinomi checks support windows against: the last good copy of
 * `products/full` in the `http_cache` table, indexed in memory, refreshed once a day with a
 * conditional request. A failed or invalid answer never replaces the copy; with no network the
 * last copy keeps serving and `status()` reports its age.
 */
export function createSupportData(options: SupportDataOptions): SupportData {
  const { cache } = options
  const log = options.log ?? silentLogger
  const now = options.now ?? currentTime
  const demand = options.demand ?? (() => true)

  let index: SupportIndex | null = null
  /** The validators of the copy in `index`; null when the stored row is not what `index` holds. */
  let validators: { etag: string | null; lastModified: string | null } | null = null
  let fetchedAt: Date | null = null
  let source: SupportDataSource = 'none'
  let lastAttemptAt: Date | null = null
  let lastError: string | null = null
  let nextRefreshAt: Date | null = null
  let failures = 0
  let inFlight: Promise<RefreshOutcome> | null = null

  function adopt(data: ParsedSupportData): void {
    index = createSupportIndex(data)
  }

  const stored = cache.get(PRODUCTS_FULL_KEY)
  if (stored) {
    try {
      adopt(readStored(stored.body))
      validators = { etag: stored.etag, lastModified: stored.lastModified }
      fetchedAt = stored.fetchedAt
      source = 'cache'
    } catch (error) {
      // An unreadable copy (damaged, or from a version with another shape) is as good as none.
      log.warn('support: the stored endoflife.date copy cannot be read', {
        error: describeError(error),
      })
    }
  }

  function accept(result: FetchResult): RefreshOutcome {
    const at = now()
    if (result.kind === 'not_modified') {
      if (index) {
        cache.touch(PRODUCTS_FULL_KEY, at)
        fetchedAt = at
        source = 'live'
        return { kind: 'not_modified' }
      }
      // The server confirmed a copy this process does not hold; the next try starts clean.
      validators = null
      return { kind: 'failed', reason: 'no copy to confirm' }
    }
    if (result.kind === 'failed') {
      return {
        kind: 'failed',
        reason: result.reason,
        ...(result.retryAfterMs !== undefined && { retryAfterMs: result.retryAfterMs }),
      }
    }
    let data: ParsedSupportData
    try {
      data = parseProductsFull(result.body)
    } catch (error) {
      return { kind: 'failed', reason: `unusable answer: ${describeError(error)}` }
    }
    cache.put({
      key: PRODUCTS_FULL_KEY,
      etag: result.etag,
      lastModified: result.lastModified,
      fetchedAt: at,
      status: 200,
      body: compress(result.body),
    })
    adopt(data)
    validators = { etag: result.etag, lastModified: result.lastModified }
    fetchedAt = at
    source = 'live'
    if (data.skipped > 0) log.warn('support: entries left out', { skipped: data.skipped })
    return { kind: 'updated' }
  }

  async function run(): Promise<RefreshOutcome> {
    lastAttemptAt = now()
    const result = await fetchProductsFull({
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.baseUrl && { baseUrl: options.baseUrl }),
      ...(index && validators && { validators }),
    })
    const outcome = accept(result)
    if (outcome.kind === 'failed') {
      lastError = outcome.reason
      failures++
      log.info('support: could not refresh the endoflife.date data', {
        reason: outcome.reason,
        usingCopy: index !== null,
      })
    } else {
      lastError = null
      failures = 0
    }
    return outcome
  }

  function refresh(): Promise<RefreshOutcome> {
    inFlight ??= run().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function tick(): Promise<{ nextDelayMs: number }> {
    const plan = (ms: number) => {
      const delay = Math.max(MIN_DELAY_MS, ms)
      nextRefreshAt = new Date(now().getTime() + delay)
      return { nextDelayMs: delay }
    }
    if (!demand()) return plan(IDLE_RECHECK_MS)
    const age = fetchedAt ? now().getTime() - fetchedAt.getTime() : Infinity
    if (index && age < REFRESH_INTERVAL_MS) return plan(REFRESH_INTERVAL_MS - age)
    const outcome = await refresh()
    if (outcome.kind !== 'failed') return plan(REFRESH_INTERVAL_MS)
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
    return plan(Math.max(backoff, outcome.retryAfterMs ?? 0))
  }

  function status(): SupportStatus {
    const current = now()
    const ageSeconds = fetchedAt
      ? Math.max(0, Math.floor((current.getTime() - fetchedAt.getTime()) / 1000))
      : null
    return {
      source,
      fetchedAt: fetchedAt?.toISOString() ?? null,
      ageSeconds,
      stale: ageSeconds !== null && ageSeconds > SUPPORT_STALE_AFTER_DAYS * 24 * 60 * 60,
      staleAfterDays: SUPPORT_STALE_AFTER_DAYS,
      generatedAt: index?.generatedAt ?? null,
      schemaVersion: index?.schemaVersion ?? null,
      counts: index?.counts() ?? { products: 0, releases: 0, purls: 0 },
      runtimes: RUNTIMES.map((runtime) => {
        const product = index?.product(RUNTIME_PRODUCTS[runtime]) ?? null
        return {
          runtime,
          product: RUNTIME_PRODUCTS[runtime],
          found: product !== null,
          basis: product ? supportBasisOf(product) : null,
          lines: product?.releases.length ?? 0,
        }
      }),
      lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
      lastError,
      nextRefreshAt: nextRefreshAt?.toISOString() ?? null,
    }
  }

  return { index: () => index, status, refresh, tick }
}
