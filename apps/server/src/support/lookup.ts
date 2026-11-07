import {
  RUNTIME_PRODUCTS,
  type Runtime,
  type SupportBasis,
  type SupportWindowState,
} from '@hinomi/shared'
import type { ParsedSupportData, SupportProduct, SupportRelease } from './products.js'
import { normalizePurl } from './purl.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_VERSION_LENGTH = 64
const MAX_VERSION_PARTS = 8

/** UTC start of a `YYYY-MM-DD` day. */
function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

/**
 * What a support date is based on (the `SupportBasis` of the finding).
 *
 * `security`: the product calls its end date "security support" and publishes at least one such
 * date. `release_cycle`: it does not, so a line's end is the day the next line replaces it (Rust,
 * whose only label is "Supported") or nothing is published at all (Bun publishes one line, `1`,
 * with no end date, so a Bun pin can only ever read as supported). Decided from the data on every
 * load, so a product that starts publishing dates moves over by itself.
 */
export function supportBasisOf(product: SupportProduct): SupportBasis {
  const security = /security/i.test(product.eolLabel ?? '')
  return security && product.releases.some((r) => r.eolFrom !== null) ? 'security' : 'release_cycle'
}

/** Whether the line ended: its date passed (the date wins over the flag), else the flag. */
export function isPastEol(release: SupportRelease, now: Date): boolean {
  return release.eolFrom !== null ? now.getTime() >= dayStart(release.eolFrom) : release.isEol
}

/**
 * Where a line stands at `now`, worst first: `eol` (ended), `ending` (ends within `windowDays`),
 * `maintenance` (active support is over, security fixes continue), else `supported`.
 */
export function windowStateOf(
  release: SupportRelease,
  now: Date,
  windowDays: number,
): SupportWindowState {
  if (isPastEol(release, now)) return 'eol'
  if (
    release.eolFrom !== null &&
    dayStart(release.eolFrom) - now.getTime() <= windowDays * DAY_MS
  ) {
    return 'ending'
  }
  const activeOver =
    release.eoasFrom !== null
      ? now.getTime() >= dayStart(release.eoasFrom)
      : release.isEoas === true
  return activeOver ? 'maintenance' : 'supported'
}

/** Whole days until the line ends (negative once it ended). Null when no end date is published. */
export function daysUntilEol(release: SupportRelease, now: Date): number | null {
  return release.eolFrom === null
    ? null
    : Math.floor((dayStart(release.eolFrom) - now.getTime()) / DAY_MS)
}

/**
 * The names a version can have as a line, most specific first: `22.11.0` gives `22.11.0`,
 * `22.11`, `22`. A leading `v` and a pre-release or build suffix are dropped.
 */
export function lineCandidates(version: string): string[] {
  if (version.length > MAX_VERSION_LENGTH) return []
  const core = (version.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '').split('.')
  if (core.length > MAX_VERSION_PARTS || core.some((part) => part === '')) return []
  const candidates: string[] = []
  for (let n = core.length; n >= 1; n--) candidates.push(core.slice(0, n).join('.'))
  return candidates
}

/** What a lookup of a pinned version answers. */
export interface LineLookup {
  /** The endoflife.date product slug. */
  product: string
  basis: SupportBasis
  /** The line the version belongs to, as the product names it. */
  line: string
  label: string
  releaseDate: string | null
  isLts: boolean
  ltsFrom: string | null
  /** End of active support, null when the product has none. */
  eoasFrom: string | null
  /** End of support (of security support when `basis` is `security`), null when none is published. */
  eolFrom: string | null
  /** The newest release of the line, as the cached copy has it. */
  latest: string | null
  state: SupportWindowState
  daysToEol: number | null
}

export interface LookupOptions {
  now: Date
  windowDays: number
}

export interface SupportIndex {
  readonly generatedAt: string | null
  readonly schemaVersion: string | null
  counts(): { products: number; releases: number; purls: number }
  /** A product by slug or alias (`node` is an alias of `nodejs`). Null when unknown. */
  product(nameOrAlias: string): SupportProduct | null
  /**
   * The products that publish a package identifier, for matching a dependency to its support
   * data: `productsForPurl('pkg:npm/next')`. Normalises the input, so `pkg:npm/next@15.0.0` and
   * `pkg:npm/%40angular/core` work. Empty when none does; more than one is possible.
   */
  productsForPurl(purl: string): SupportProduct[]
  /** The line of `product` that `version` belongs to, or null (unknown product, or a line the copy does not have yet). */
  line(product: string, version: string): SupportRelease | null
  /** The line, its dates and its window state; null when `line` is. */
  lookup(product: string, version: string, options: LookupOptions): LineLookup | null
  /** `lookup` for a runtime of Q12 (`node`, `bun`, `rust`) through its endoflife.date product. */
  lookupRuntime(runtime: Runtime, version: string, options: LookupOptions): LineLookup | null
}

/** Builds the lookups over a parsed copy. Everything is keyed by Maps. */
export function createSupportIndex(data: ParsedSupportData): SupportIndex {
  const aliases = new Map<string, string>()
  const purls = new Map<string, SupportProduct[]>()
  const lines = new Map<string, Map<string, SupportRelease>>()
  let releaseCount = 0
  for (const product of data.products.values()) {
    for (const alias of product.aliases) {
      // A slug is never shadowed by another product's alias.
      if (!data.products.has(alias) && !aliases.has(alias)) aliases.set(alias, product.name)
    }
    for (const key of product.purls) {
      const list = purls.get(key)
      if (list) list.push(product)
      else purls.set(key, [product])
    }
    lines.set(product.name, new Map(product.releases.map((r) => [r.name, r])))
    releaseCount += product.releases.length
  }

  function product(nameOrAlias: string): SupportProduct | null {
    const slug = data.products.has(nameOrAlias) ? nameOrAlias : aliases.get(nameOrAlias)
    return slug === undefined ? null : (data.products.get(slug) ?? null)
  }

  function resolve(
    productName: string,
    version: string,
  ): { product: SupportProduct; release: SupportRelease } | null {
    const found = product(productName)
    const byName = found ? lines.get(found.name) : undefined
    if (!found || !byName) return null
    for (const candidate of lineCandidates(version)) {
      const release = byName.get(candidate)
      if (release) return { product: found, release }
    }
    return null
  }

  function lookup(productName: string, version: string, options: LookupOptions) {
    const hit = resolve(productName, version)
    if (!hit) return null
    const { release } = hit
    const result: LineLookup = {
      product: hit.product.name,
      basis: supportBasisOf(hit.product),
      line: release.name,
      label: release.label,
      releaseDate: release.releaseDate,
      isLts: release.isLts,
      ltsFrom: release.ltsFrom,
      eoasFrom: release.eoasFrom,
      eolFrom: release.eolFrom,
      latest: release.latest?.name ?? null,
      state: windowStateOf(release, options.now, options.windowDays),
      daysToEol: daysUntilEol(release, options.now),
    }
    return result
  }

  return {
    generatedAt: data.generatedAt,
    schemaVersion: data.schemaVersion,
    counts: () => ({ products: data.products.size, releases: releaseCount, purls: purls.size }),
    product,
    productsForPurl(purl) {
      const key = normalizePurl(purl)
      return key === null ? [] : [...(purls.get(key) ?? [])]
    },
    line: (productName, version) => resolve(productName, version)?.release ?? null,
    lookup,
    lookupRuntime: (runtime, version, options) =>
      lookup(RUNTIME_PRODUCTS[runtime], version, options),
  }
}
