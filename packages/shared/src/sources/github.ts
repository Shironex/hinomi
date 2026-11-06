import { z } from 'zod'

/**
 * Source-neutral advisory model. The GitHub source fills it from Dependabot alerts and the OSV
 * source maps to the same shape, so downstream code never branches on where an advisory came from.
 */

export const severitySchema = z.enum(['critical', 'high', 'moderate', 'low'])
export type Severity = z.infer<typeof severitySchema>

export const ecosystemSchema = z.enum([
  'npm',
  'pip',
  'rubygems',
  'maven',
  'nuget',
  'composer',
  'go',
  'rust',
  'actions',
  'pub',
  'swift',
  'erlang',
  'other',
])
export type Ecosystem = z.infer<typeof ecosystemSchema>

export const dependencyScopeSchema = z.enum(['runtime', 'dev'])
export type DependencyScope = z.infer<typeof dependencyScopeSchema>

const isoDate = z.iso.datetime({ offset: true })

export const advisoryRecordSchema = z.object({
  ghsaId: z.string(),
  cveIds: z.array(z.string()),
  package: z.string(),
  ecosystem: ecosystemSchema,
  severity: severitySchema,
  /** CVSS base score 0 to 10, null when the advisory has none. */
  cvss: z.number().min(0).max(10).nullable(),
  summary: z.string(),
  vulnerableRange: z.string(),
  firstPatched: z.string().nullable(),
  publishedAt: isoDate.nullable(),
})
export type AdvisoryRecord = z.infer<typeof advisoryRecordSchema>

/** One advisory seen on one repo. Joins to `AdvisoryRecord` by ghsaId, package and ecosystem. */
export const repoAlertRecordSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  alertNumber: z.number().int(),
  ghsaId: z.string(),
  package: z.string(),
  ecosystem: ecosystemSchema,
  /** Null when GitHub did not report a scope. */
  scope: dependencyScopeSchema.nullable(),
  manifestPath: z.string().nullable(),
  createdAt: isoDate,
  dismissedAt: isoDate.nullable(),
})
export type RepoAlertRecord = z.infer<typeof repoAlertRecordSchema>

/** An alert someone dismissed on GitHub, with the reason they gave. */
export const dismissedAlertRecordSchema = repoAlertRecordSchema.extend({
  dismissedAt: isoDate,
  /** GitHub's reason, for example "no_bandwidth" or "tolerable_risk". Null when absent. */
  dismissReason: z.string().nullable(),
  dismissComment: z.string().nullable(),
})
export type DismissedAlertRecord = z.infer<typeof dismissedAlertRecordSchema>

/**
 * `alerts` are the open ones. `dismissed` are the dismissed ones, kept apart so a dismissal is
 * never mistaken for a fix. `advisories` covers both lists.
 */
export const dependabotAlertsResultSchema = z.object({
  advisories: z.array(advisoryRecordSchema),
  alerts: z.array(repoAlertRecordSchema),
  dismissed: z.array(dismissedAlertRecordSchema),
})
export type DependabotAlertsResult = z.infer<typeof dependabotAlertsResultSchema>

export const repoVisibilitySchema = z.enum(['public', 'private', 'internal'])
export type RepoVisibility = z.infer<typeof repoVisibilitySchema>

/**
 * `alertsEnabled` is true or false when GitHub answered, and null when the token may not read
 * the setting (HTTP 403). Null is a blind spot, not "disabled".
 */
export const repoHealthSchema = z.object({
  owner: z.string(),
  name: z.string(),
  archived: z.boolean(),
  defaultBranch: z.string(),
  visibility: repoVisibilitySchema,
  alertsEnabled: z.boolean().nullable(),
  pushedAt: isoDate.nullable(),
})
export type RepoHealth = z.infer<typeof repoHealthSchema>

export const accountRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  archived: z.boolean(),
  fork: z.boolean(),
  defaultBranch: z.string().nullable(),
  visibility: repoVisibilitySchema,
  pushedAt: isoDate.nullable(),
})
export type AccountRepo = z.infer<typeof accountRepoSchema>

export const githubConnectionSchema = z.object({
  login: z.string(),
  /** OAuth scopes of a classic token. Null for fine-grained tokens, which report none. */
  scopes: z.array(z.string()).nullable(),
})
export type GithubConnection = z.infer<typeof githubConnectionSchema>
