import { z } from 'zod'

// Lockfile dependencies

/** Ecosystem names as OSV spells them. */
export const osvEcosystemSchema = z.enum(['npm', 'crates.io'])
export type OsvEcosystem = z.infer<typeof osvEcosystemSchema>

/**
 * Whether a dependency ends up in the shipped app. `unknown` when the lockfile
 * alone cannot tell (yarn without package.json, Cargo).
 */
export const lockfileScopeSchema = z.enum(['runtime', 'dev', 'unknown'])
export type LockfileScope = z.infer<typeof lockfileScopeSchema>

export const lockfileDependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  ecosystem: osvEcosystemSchema,
  scope: lockfileScopeSchema,
  /** Listed by a manifest (root or workspace) rather than pulled in transitively. */
  direct: z.boolean(),
  /**
   * Shortest chain of package names from a direct dependency down to this one, both included.
   * Missing when the lockfile does not record the graph (npm v1).
   */
  path: z.array(z.string()).optional(),
  /** Repo relative path of the lockfile it was read from, when known. */
  lockfile: z.string().optional(),
  /**
   * Manifests that list it directly: workspace folders relative to the lockfile (`.` for the
   * root project) for npm, pnpm, yarn and bun; workspace crate names for Cargo, whose lockfile
   * does not record folders. Missing for transitive packages and when the lockfile cannot tell.
   */
  workspaces: z.array(z.string()).optional(),
})
export type LockfileDependency = z.infer<typeof lockfileDependencySchema>

// OSV API (only the fields Hinomi reads; unknown fields are dropped)

export const osvQuerySchema = z.object({
  package: z.object({ name: z.string(), ecosystem: z.string() }),
  version: z.string(),
  page_token: z.string().optional(),
})
export type OsvQuery = z.infer<typeof osvQuerySchema>

export const osvQueryBatchResponseSchema = z.object({
  results: z.array(
    z.object({
      vulns: z.array(z.object({ id: z.string(), modified: z.string().optional() })).optional(),
      next_page_token: z.string().optional(),
    }),
  ),
})
export type OsvQueryBatchResponse = z.infer<typeof osvQueryBatchResponseSchema>

const osvEventSchema = z.object({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
  last_affected: z.string().optional(),
  limit: z.string().optional(),
})
export type OsvEvent = z.infer<typeof osvEventSchema>

const osvRangeSchema = z.object({
  type: z.string(),
  events: z.array(osvEventSchema),
})
export type OsvRange = z.infer<typeof osvRangeSchema>

const osvAffectedSchema = z.object({
  package: z.object({ name: z.string(), ecosystem: z.string() }).optional(),
  ranges: z.array(osvRangeSchema).optional(),
  versions: z.array(z.string()).optional(),
  database_specific: z.record(z.string(), z.unknown()).optional(),
  ecosystem_specific: z.record(z.string(), z.unknown()).optional(),
})
export type OsvAffected = z.infer<typeof osvAffectedSchema>

export const osvVulnerabilitySchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  details: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  modified: z.string().optional(),
  published: z.string().optional(),
  withdrawn: z.string().optional(),
  severity: z.array(z.object({ type: z.string(), score: z.string() })).optional(),
  affected: z.array(osvAffectedSchema).optional(),
  database_specific: z.record(z.string(), z.unknown()).optional(),
})
export type OsvVulnerability = z.infer<typeof osvVulnerabilitySchema>

// Source-neutral advisory match

/** GitHub's severity words, so OSV and GitHub findings rank on one scale. */
export const advisorySeveritySchema = z.enum(['critical', 'high', 'moderate', 'low', 'unknown'])
export type AdvisorySeverity = z.infer<typeof advisorySeveritySchema>

export const advisoryCvssSchema = z.object({
  /** Base score, null when only a vector Hinomi cannot score (CVSS v4) is given. */
  score: z.number().min(0).max(10).nullable(),
  vector: z.string(),
})
export type AdvisoryCvss = z.infer<typeof advisoryCvssSchema>

export const osvAdvisoryMatchSchema = z.object({
  source: z.literal('osv'),
  osvId: z.string(),
  /** GHSA id from the OSV id or its aliases; the key for deduping with GitHub. */
  ghsaId: z.string().nullable(),
  cveIds: z.array(z.string()),
  aliases: z.array(z.string()),
  package: z.string(),
  ecosystem: osvEcosystemSchema,
  severity: advisorySeveritySchema,
  /** The value severity was derived from: database severity word or CVSS vector. */
  severityRaw: z.string().nullable(),
  cvss: advisoryCvssSchema.nullable(),
  summary: z.string().nullable(),
  /** OSV `details`: the long description. */
  description: z.string().nullable().optional(),
  /** GitHub style range containing the installed version, e.g. ">= 1.0.0, < 1.2.3". */
  vulnerableRange: z.string().nullable(),
  /** Lowest fixed version above the installed one, null when no fix exists yet. */
  firstPatched: z.string().nullable(),
  publishedAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  url: z.string(),
  installedVersion: z.string(),
  scope: lockfileScopeSchema,
  direct: z.boolean(),
  /** See `LockfileDependency.path`. */
  path: z.array(z.string()).optional(),
  /** See `LockfileDependency.lockfile`. */
  lockfile: z.string().optional(),
})
export type OsvAdvisoryMatch = z.infer<typeof osvAdvisoryMatchSchema>
