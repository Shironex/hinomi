import { z } from 'zod'
import { supportBasisSchema, runtimeSchema } from './guards.js'

// The support data cache (see docs/design/phase-2.md section 5.3 and 5.4): what Hinomi knows
// about endoflife.date, and the window states a release line can be in.

/** The warning window before end of life, in days (decision Q8). Settings can change it. */
export const SUPPORT_WINDOW_DEFAULT_DAYS = 90
export const SUPPORT_WINDOW_MIN_DAYS = 1
export const SUPPORT_WINDOW_MAX_DAYS = 365

/**
 * The "behind latest" rule of Rust and Bun (decision Q12a): a pinned version warns once it is more
 * than this many releases behind the latest (Rust: stable minor releases, about six weeks each;
 * Bun: minor releases). Settings can change it per runtime.
 */
export const RUNTIME_BEHIND_DEFAULT_RELEASES = 4
export const RUNTIME_BEHIND_MIN_RELEASES = 1
export const RUNTIME_BEHIND_MAX_RELEASES = 50

/** After this many days without a successful check the cached copy counts as stale. */
export const SUPPORT_STALE_AFTER_DAYS = 7

/**
 * Where a release line stands, worst last.
 * `supported`: nothing ends soon. `maintenance`: active support is over, security fixes
 * continue. `ending`: end of life is within the warning window. `eol`: end of life passed.
 */
export const SUPPORT_WINDOW_STATES = ['supported', 'maintenance', 'ending', 'eol'] as const
export const supportWindowStateSchema = z.enum(SUPPORT_WINDOW_STATES)
export type SupportWindowState = z.infer<typeof supportWindowStateSchema>

/**
 * Where the data in use came from. `live`: the last check succeeded in this run of the server.
 * `cache`: the stored copy of an earlier run, not refreshed yet. `none`: nothing was ever fetched.
 */
export const SUPPORT_DATA_SOURCES = ['live', 'cache', 'none'] as const
export const supportDataSourceSchema = z.enum(SUPPORT_DATA_SOURCES)
export type SupportDataSource = z.infer<typeof supportDataSourceSchema>

const iso = z.string()

/** What endoflife.date publishes for one runtime (Q12), as the cached copy has it. */
export const supportRuntimeInfoSchema = z.object({
  runtime: runtimeSchema,
  /** The endoflife.date product slug. */
  product: z.string(),
  /** False when the cached copy has no such product (then nothing can be checked). */
  found: z.boolean(),
  /** Null when the product is not in the copy. */
  basis: supportBasisSchema.nullable(),
  /** Release lines the product has. */
  lines: z.number().int().min(0),
})
export type SupportRuntimeInfo = z.infer<typeof supportRuntimeInfoSchema>

export const supportStatusSchema = z.object({
  source: supportDataSourceSchema,
  /** When the data was last confirmed current (a 200 or a 304). Null before the first fetch. */
  fetchedAt: iso.nullable(),
  /** Seconds since `fetchedAt`. Null before the first fetch. */
  ageSeconds: z.number().int().min(0).nullable(),
  /** The cached copy is older than `staleAfterDays`: support checks run but say so. */
  stale: z.boolean(),
  staleAfterDays: z.number().int(),
  /** The API's own `generated_at` of the copy in use. */
  generatedAt: iso.nullable(),
  /** The API's schema version of the copy in use. */
  schemaVersion: z.string().nullable(),
  counts: z.object({
    products: z.number().int().min(0),
    releases: z.number().int().min(0),
    /** Distinct package identifiers (purls) the index can look up. */
    purls: z.number().int().min(0),
  }),
  runtimes: z.array(supportRuntimeInfoSchema),
  /** The last try, successful or not. Null before the first one. */
  lastAttemptAt: iso.nullable(),
  /** Why the last try failed, or null when it did not. */
  lastError: z.string().nullable(),
  /** When the next refresh is planned. Null when the daily job is not running. */
  nextRefreshAt: iso.nullable(),
})
export type SupportStatus = z.infer<typeof supportStatusSchema>
