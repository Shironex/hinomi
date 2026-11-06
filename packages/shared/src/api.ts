import { z } from 'zod'
import {
  blindSpotTypeSchema,
  coverageNoteTypeSchema,
  deploymentReachSchema,
  findingKindSchema,
  findingScopeSchema,
  findingStateSchema,
  reporterSchema,
  scanRunStatusSchema,
  scanTriggerSchema,
  sourceAuthSchema,
  sourceKindSchema,
} from './model.js'
import { deploymentKindSchema } from './sources/coolify.js'
import { severitySchema } from './sources/github.js'
import { advisorySeveritySchema } from './sources/osv.js'

// Contract of the JSON API under /api (see docs/api.md). The server validates
// every request with these schemas and every response before it is sent;
// the SPA parses responses with the same schemas. Timestamps are ISO 8601
// strings in UTC.

const isoDate = z.iso.datetime({ offset: true })
const id = z.number().int().positive()

// ---------------------------------------------------------------------------
// Errors

export const API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'invalid_json',
  'payload_too_large',
  'unsupported_media_type',
  'not_found',
  'conflict',
  'secret_key_missing',
  'not_supported',
  'internal',
  'unavailable',
] as const
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES)
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>

/** Every non 2xx answer has this shape. The message is safe to show to a person. */
export const apiErrorSchema = z.object({
  error: z.object({ code: apiErrorCodeSchema, message: z.string() }),
})
export type ApiErrorBody = z.infer<typeof apiErrorSchema>

// ---------------------------------------------------------------------------
// Query helpers

/** A path id: a positive integer written as a string. */
export const idParamSchema = z.object({ id: z.coerce.number().int().positive() })

/** `a,b,c` in a query string, each value checked against the enum. Empty means no filter. */
function csvOf<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .max(500)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(item).max(20))
}

const csvIds = z
  .string()
  .max(500)
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^[1-9][0-9]{0,15}$/, 'Must be an id')
          .transform(Number),
      )
      .max(50),
  )

// ---------------------------------------------------------------------------
// Shared pieces

export const repoRefSchema = z.object({
  id,
  owner: z.string(),
  name: z.string(),
  /** `owner/name`. */
  fullName: z.string(),
  archived: z.boolean(),
  /** Dependabot alerts on. Null when GitHub has not been asked or the token may not read it. */
  alertsEnabled: z.boolean().nullable(),
  lastScannedAt: isoDate.nullable(),
})
export type RepoRef = z.infer<typeof repoRefSchema>

export const deploymentRefSchema = z.object({
  id,
  name: z.string(),
  kind: deploymentKindSchema,
  reach: deploymentReachSchema,
  server: z.string().nullable(),
  domains: z.array(z.string()),
})
export type DeploymentRef = z.infer<typeof deploymentRefSchema>

/** The four factors behind a rank, shown as the rank marker next to every row. */
export const exposureFactorsSchema = z.object({
  severity: severitySchema,
  runtime: z.boolean(),
  deployed: z.boolean(),
  public: z.boolean(),
})
export type ExposureFactorsDto = z.infer<typeof exposureFactorsSchema>

/**
 * Display tiers of the alerts list. Blind spots come first, then advisories:
 * 1 exposed (critical or high, runtime, public), 2 deployed internal only,
 * 3 deployed and public but moderate or low, 4 deployed dev dependencies,
 * 5 not deployed. Coverage notes (image only deployments) come last.
 * Within a tier rows keep their rank order.
 */
export const FINDING_TIERS = [
  'blind_spot',
  'exposed',
  'internal',
  'public_low',
  'dev',
  'not_deployed',
  'coverage',
] as const
export const findingTierSchema = z.enum(FINDING_TIERS)
export type FindingTier = z.infer<typeof findingTierSchema>

export const advisorySummarySchema = z.object({
  id,
  /** GHSA id when there is one, otherwise the OSV id. */
  advisoryKey: z.string(),
  ghsaId: z.string().nullable(),
  cveIds: z.array(z.string()),
  ecosystem: z.string(),
  packageName: z.string(),
  severity: advisorySeveritySchema,
  cvssScore: z.number().nullable(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  firstPatchedVersion: z.string().nullable(),
})
export type AdvisorySummary = z.infer<typeof advisorySummarySchema>

export const findingListItemSchema = z.object({
  id,
  kind: findingKindSchema,
  /** Higher is more urgent. The list is sorted by it unless grouped. */
  rank: z.number(),
  tier: findingTierSchema,
  factors: exposureFactorsSchema,
  /** The advisory has no severity Hinomi could score; it ranks as moderate. */
  unscored: z.boolean(),
  /** Every deployment it runs in is stopped: ranked as not deployed, shown with a badge. */
  stopped: z.boolean(),
  state: findingStateSchema,
  stateReason: z.string().nullable(),
  stateUntil: isoDate.nullable(),
  /** The snooze or acceptance lasts until a new advisory appears for the same package and repo. */
  stateUntilNewAdvisory: z.boolean(),
  scope: findingScopeSchema,
  /** Sources reporting the advisory now (empty for blind spots). */
  sources: z.array(reporterSchema),
  blindSpotType: blindSpotTypeSchema.nullable(),
  /** Set for coverage notes, null for advisories and blind spots. */
  coverageNote: coverageNoteTypeSchema.nullable(),
  advisory: advisorySummarySchema.nullable(),
  installedVersion: z.string().nullable(),
  repo: repoRefSchema.nullable(),
  deployments: z.array(deploymentRefSchema),
  firstSeenAt: isoDate,
  lastSeenAt: isoDate,
  fixedAt: isoDate.nullable(),
})
export type FindingListItem = z.infer<typeof findingListItemSchema>

export const findingEventSchema = z.object({
  id,
  findingId: id,
  /** opened, reopened, fixed, resolved, snoozed, accepted, snooze_expired, ... */
  type: z.string(),
  fromState: findingStateSchema.nullable(),
  toState: findingStateSchema.nullable(),
  reason: z.string().nullable(),
  until: isoDate.nullable(),
  /** A snooze or acceptance made until a new advisory instead of a date. */
  untilNewAdvisory: z.boolean(),
  actor: z.enum(['system', 'user']),
  at: isoDate,
})
export type FindingEvent = z.infer<typeof findingEventSchema>

export const severityCountsSchema = z.object({
  critical: z.number().int(),
  high: z.number().int(),
  moderate: z.number().int(),
  low: z.number().int(),
})
export type SeverityCounts = z.infer<typeof severityCountsSchema>

export const scanSourceResultSchema = z.object({
  status: z.enum(['ok', 'error', 'skipped']),
  counts: z.record(z.string(), z.number()),
  error: z.string().optional(),
  durationMs: z.number().optional(),
})

export const scanRunSchema = z.object({
  id,
  trigger: scanTriggerSchema,
  status: scanRunStatusSchema,
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
  durationMs: z.number().int().nullable(),
  sourceResults: z.partialRecord(sourceKindSchema, scanSourceResultSchema),
  findingsOpened: z.number().int(),
  findingsFixed: z.number().int(),
  error: z.string().nullable(),
})
export type ScanRun = z.infer<typeof scanRunSchema>

// ---------------------------------------------------------------------------
// Sources

/** A connected source. Secrets are never sent: only whether one is stored. */
export const sourceSchema = z.object({
  id,
  kind: sourceKindSchema,
  name: z.string(),
  baseUrl: z.string().nullable(),
  enabled: z.boolean(),
  /** `github_app` only for GitHub sources connected through a GitHub App. */
  auth: sourceAuthSchema,
  /** GitHub App ID or Client ID. Null unless `auth` is `github_app`. */
  appId: z.string().nullable(),
  /** GitHub App installation ID. Null unless `auth` is `github_app`. */
  installationId: z.string().nullable(),
  /** The secret is stored: the token, or for a GitHub App its private key. */
  hasToken: z.boolean(),
  lastOkAt: isoDate.nullable(),
  lastErrorAt: isoDate.nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type SourceDto = z.infer<typeof sourceSchema>

export const sourcesResponseSchema = z.object({
  sources: z.array(sourceSchema),
  /** False when HINOMI_SECRET_KEY is not set: tokens cannot be stored until it is. */
  canStoreTokens: z.boolean(),
})
export type SourcesResponse = z.infer<typeof sourcesResponseSchema>

const sourceName = z.string().trim().min(1).max(100)
const token = z.string().trim().min(1).max(500)
/** The App ID (a number) or the Client ID (`Iv23...`); GitHub accepts either as the JWT issuer. */
const appId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Must be the App ID or the Client ID of the GitHub App')
const installationId = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{0,19}$/, 'Must be the installation ID, a number')
/** The .pem file GitHub hands out for the app, PKCS#1 or PKCS#8. */
const privateKey = z
  .string()
  .trim()
  .max(16_000)
  .regex(
    /^-----BEGIN (RSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END (RSA )?PRIVATE KEY-----$/,
    'Must be the private key (.pem) of the GitHub App',
  )
const httpUrl = z
  .string()
  .trim()
  .max(500)
  .regex(/^https?:\/\/[^\s/?#]+[^\s]*$/i, 'Must be an http or https URL')

export const createSourceRequestSchema = z.strictObject({
  kind: sourceKindSchema,
  name: sourceName,
  /** Coolify: required. GitHub: optional, for GitHub Enterprise. OSV: not used. */
  baseUrl: httpUrl.nullable().optional(),
  /** Coolify and GitHub with token auth: required. Encrypted before it is stored. */
  token: token.optional(),
  enabled: z.boolean().optional(),
  /** GitHub only. Defaults to `token`. */
  auth: sourceAuthSchema.optional(),
  /** GitHub App: all three are required. The private key is encrypted before it is stored. */
  appId: appId.optional(),
  installationId: installationId.optional(),
  privateKey: privateKey.optional(),
})
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>

export const updateSourceRequestSchema = z
  .strictObject({
    name: sourceName.optional(),
    baseUrl: httpUrl.nullable().optional(),
    /** A new token replaces the stored one. */
    token: token.optional(),
    enabled: z.boolean().optional(),
    /** GitHub: switching how it signs in also needs the new secret (token or private key). */
    auth: sourceAuthSchema.optional(),
    appId: appId.optional(),
    installationId: installationId.optional(),
    /** A new private key replaces the stored one. */
    privateKey: privateKey.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>

/** Test a Coolify or GitHub token before saving it. */
export const testTokenRequestSchema = z.strictObject({
  kind: z.enum(['coolify', 'github']),
  auth: z.literal('token').optional(),
  baseUrl: httpUrl.nullable().optional(),
  token,
})

/** Test GitHub App credentials before saving them. */
export const testGithubAppRequestSchema = z.strictObject({
  kind: z.literal('github'),
  auth: z.literal('github_app'),
  baseUrl: httpUrl.nullable().optional(),
  appId,
  installationId,
  privateKey,
})

/** Test credentials before saving them (onboarding). */
export const testSourceRequestSchema = z.discriminatedUnion('auth', [
  testTokenRequestSchema,
  testGithubAppRequestSchema,
])
export type TestSourceRequest = z.infer<typeof testSourceRequestSchema>

export const sourceTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** One line for the UI, for example "Connected as kestrel-bot". */
    message: z.string(),
    /** Coolify version, when it says. */
    version: z.string().nullable().optional(),
    /** GitHub login of the token. */
    login: z.string().optional(),
    /** Classic token scopes; null for fine-grained tokens. */
    scopes: z.array(z.string()).nullable().optional(),
    /** GitHub App: the user or organization the app is installed on. */
    account: z.string().optional(),
    /** GitHub App: every repo of the account, or only the selected ones. */
    repositorySelection: z.enum(['all', 'selected']).optional(),
    /** GitHub App: repos the installation can read. */
    repoCount: z.number().int().optional(),
    /** GitHub App: permissions Hinomi needs that the installation lacks, like `dependabot_alerts`. */
    missingPermissions: z.array(z.string()).optional(),
  }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
])
export type SourceTestResult = z.infer<typeof sourceTestResultSchema>

// ---------------------------------------------------------------------------
// Overview

export const sourceHealthSchema = z.object({
  /**
   * The source row. Null for OSV.dev when it has none: it needs no connection,
   * so it is listed from the scan setting and the last scans instead.
   */
  id: id.nullable(),
  kind: sourceKindSchema,
  name: z.string(),
  /** never: not synced yet; disabled: switched off; missing_token: cannot run. */
  status: z.enum(['ok', 'error', 'never', 'disabled', 'missing_token']),
  lastOkAt: isoDate.nullable(),
  lastErrorAt: isoDate.nullable(),
  lastError: z.string().nullable(),
})
export type SourceHealth = z.infer<typeof sourceHealthSchema>

export const activityItemSchema = findingEventSchema.extend({
  finding: z.object({
    id,
    kind: findingKindSchema,
    /** Package and advisory id, or the blind spot type. */
    title: z.string(),
    severity: severitySchema,
    repo: z.string().nullable(),
  }),
})
export type ActivityItem = z.infer<typeof activityItemSchema>

/** Funnel steps that narrow alerts down to exposed ones, in order. */
export const FUNNEL_STEPS = [
  'total',
  'deployed',
  'runtime',
  'criticalOrHigh',
  'public',
  'exposed',
] as const
export const funnelStepSchema = z.enum(FUNNEL_STEPS)
export type FunnelStep = z.infer<typeof funnelStepSchema>

export const funnelReachSchema = z.object({
  repos: z.number().int(),
  apps: z.number().int(),
})
export type FunnelReach = z.infer<typeof funnelReachSchema>

export const overviewResponseSchema = z.object({
  /** Advisory funnel, fixed findings left out. Every step narrows the previous one. */
  funnel: z.object({
    total: z.number().int(),
    deployed: z.number().int(),
    runtime: z.number().int(),
    criticalOrHigh: z.number().int(),
    public: z.number().int(),
    /** Critical or high, runtime, public, not fixed. */
    exposed: z.number().int(),
    /** Exposed with no snooze or accepted risk in force. */
    needsAction: z.number().int(),
    /** Dismissed on GitHub with no other source reporting them; never exposed. */
    dismissedUpstream: z.number().int(),
  }),
  blindSpots: z.object({
    total: z.number().int(),
    deployed: z.number().int(),
    public: z.number().int(),
    needsAction: z.number().int(),
  }),
  /** Distinct repos and apps (deployments) behind each funnel step, same steps as `funnel`. */
  funnelReach: z.record(funnelStepSchema, funnelReachSchema),
  /** Advisory counts per display tier (fixed left out). */
  tiers: z.record(findingTierSchema, z.number().int()),
  /** The same counts split by effective severity (blind spots by the severity they rank as). */
  tierSeverity: z.record(findingTierSchema, severityCountsSchema),
  lastScan: scanRunSchema.nullable(),
  nextScanAt: isoDate.nullable(),
  sources: z.array(sourceHealthSchema),
  /** Latest finding events, newest first. */
  recentActivity: z.array(activityItemSchema),
})
export type OverviewResponse = z.infer<typeof overviewResponseSchema>

// ---------------------------------------------------------------------------
// Findings

export const FINDING_GROUPS = ['none', 'tier', 'repo', 'advisory'] as const
export const findingGroupSchema = z.enum(FINDING_GROUPS)
export type FindingGroup = z.infer<typeof findingGroupSchema>

export const FINDINGS_PAGE_MAX = 200

/**
 * Query of GET /api/findings. List filters take comma separated values.
 * Without `state`, fixed findings are left out (dismissed upstream ones stay, like accepted risks).
 */
export const findingsQuerySchema = z.strictObject({
  tier: csvOf(findingTierSchema).optional(),
  state: csvOf(findingStateSchema).optional(),
  severity: csvOf(severitySchema).optional(),
  source: csvOf(reporterSchema).optional(),
  /** any (default): reported by at least one listed source; all: by every listed source. */
  sourceMatch: z.enum(['any', 'all']).default('any'),
  scope: csvOf(findingScopeSchema).optional(),
  kind: csvOf(findingKindSchema).optional(),
  /** Repo ids. */
  repo: csvIds.optional(),
  /** Deployment ids. */
  deployment: csvIds.optional(),
  /** Case-insensitive match on package, advisory ids, summary, repo and blind spot type. */
  q: z.string().trim().max(200).optional(),
  /** Sort by group first (rank inside each group) and return the group sizes. */
  group: findingGroupSchema.default('none'),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(FINDINGS_PAGE_MAX).default(50),
})
export type FindingsQuery = z.input<typeof findingsQuerySchema>

export const findingGroupInfoSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
})

export const findingsResponseSchema = z.object({
  items: z.array(findingListItemSchema),
  /** Rows matching the filters, over every page. */
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  /** Offset of the next page, null on the last one. */
  nextOffset: z.number().int().nullable(),
  group: findingGroupSchema,
  /** Group sizes over every matching row, in display order. Empty when not grouped. */
  groups: z.array(findingGroupInfoSchema),
})
export type FindingsResponse = z.infer<typeof findingsResponseSchema>

/** An immediate notification that announced a finding on one channel. */
export const findingNotificationSchema = z.object({
  channelId: z.string(),
  /** Null when the channel was removed since. */
  channelName: z.string().nullable(),
  channelKind: z.string().nullable(),
  /** The announced event: `opened` or `reopened`. */
  event: z.string(),
  eventId: id,
  /** When it was sent. Sends recorded before this field existed fall back to the event time. */
  sentAt: isoDate,
})
export type FindingNotification = z.infer<typeof findingNotificationSchema>

export const findingDetailSchema = findingListItemSchema.extend({
  advisory: advisorySummarySchema
    .extend({
      aliases: z.array(z.string()),
      cvssVector: z.string().nullable(),
      vulnerableRanges: z.array(z.string()),
      publishedAt: isoDate.nullable(),
      withdrawnAt: isoDate.nullable(),
      /** Long description (markdown as the source wrote it), null when no source gave one. */
      description: z.string().nullable(),
    })
    .nullable(),
  versions: z.object({
    installed: z.string().nullable(),
    firstPatched: z.string().nullable(),
    vulnerableRanges: z.array(z.string()),
  }),
  dependency: z.object({
    scope: findingScopeSchema,
    manifestPaths: z.array(z.string()),
    /**
     * How the package is pulled in, from a direct dependency down to the vulnerable package
     * (both included). Null when no lockfile Hinomi parsed shows it.
     */
    path: z.array(z.string()).nullable(),
    /** lockfile: `path` is the chain; manifest: only the manifest is known; package: neither. */
    pathSource: z.enum(['lockfile', 'manifest', 'package']),
  }),
  /** Decision and scan history, newest first. */
  history: z.array(findingEventSchema),
  /** Notifications sent about it, newest first. Daily digests are not recorded per finding. */
  notifications: z.array(findingNotificationSchema),
})
export type FindingDetail = z.infer<typeof findingDetailSchema>

const reason = z.string().trim().min(1, 'A reason is required').max(500)

const futureDate = isoDate.refine((value) => Date.parse(value) > Date.now(), {
  message: 'The expiry must be in the future',
})

const deferFields = {
  reason,
  /** Expiry in the future. */
  until: futureDate.optional(),
  /** Instead of a date: lasts until a new advisory appears for the same package and repo. */
  untilNewAdvisory: z.literal(true).optional(),
}

const oneExpiry = (value: { until?: string | undefined; untilNewAdvisory?: true | undefined }) =>
  (value.until === undefined) !== (value.untilNewAdvisory === undefined)
const ONE_EXPIRY = { message: 'Give either an expiry date or untilNewAdvisory', path: ['until'] }

/** Snooze or accept: a reason and an expiry (a future date, or until a new advisory) are required. */
export const deferFindingRequestSchema = z.strictObject(deferFields).refine(oneExpiry, ONE_EXPIRY)
export type DeferFindingRequest = z.infer<typeof deferFindingRequestSchema>

export const reopenFindingRequestSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
})
export type ReopenFindingRequest = z.infer<typeof reopenFindingRequestSchema>

export const BULK_FINDINGS_MAX = 200

/** One decision for many findings. Each finding is changed on its own; failures are listed. */
export const bulkFindingsRequestSchema = z.discriminatedUnion('action', [
  z
    .strictObject({
      action: z.enum(['snooze', 'accept']),
      ids: z.array(id).min(1).max(BULK_FINDINGS_MAX),
      ...deferFields,
    })
    .refine(oneExpiry, ONE_EXPIRY),
  z.strictObject({
    action: z.literal('reopen'),
    ids: z.array(id).min(1).max(BULK_FINDINGS_MAX),
    reason: z.string().trim().max(500).optional(),
  }),
])
export type BulkFindingsRequest = z.infer<typeof bulkFindingsRequestSchema>

export const bulkFindingResultSchema = z.discriminatedUnion('ok', [
  z.object({ id, ok: z.literal(true), state: findingStateSchema }),
  z.object({
    id,
    ok: z.literal(false),
    error: z.object({ code: apiErrorCodeSchema, message: z.string() }),
  }),
])
export type BulkFindingResult = z.infer<typeof bulkFindingResultSchema>

export const bulkFindingsResponseSchema = z.object({
  /** One entry per requested id, in request order. */
  results: z.array(bulkFindingResultSchema),
  ok: z.number().int(),
  failed: z.number().int(),
})
export type BulkFindingsResponse = z.infer<typeof bulkFindingsResponseSchema>

// ---------------------------------------------------------------------------
// Deployments and repo mapping

export const repoOverrideSchema = z.object({
  repo: repoRefSchema,
  note: z.string().nullable(),
  createdAt: isoDate,
})
export type RepoOverride = z.infer<typeof repoOverrideSchema>

export const deploymentItemSchema = deploymentRefSchema.extend({
  source: z.object({ id, kind: sourceKindSchema, name: z.string() }),
  externalId: z.string(),
  status: z.string().nullable(),
  image: z.string().nullable(),
  gitRepository: z.string().nullable(),
  gitBranch: z.string().nullable(),
  lastDeployedAt: isoDate.nullable(),
  firstSeenAt: isoDate,
  lastSeenAt: isoDate,
  /** auto: from the git repository; override: set by hand; none: nothing mapped. */
  mapping: z.enum(['auto', 'override', 'none']),
  /** Repos the deployment runs (overrides replace the automatic repo). */
  repos: z.array(repoRefSchema),
  coverage: z.object({
    /** Dependabot alerts on every mapped repo; unknown when any is not known; none without a repo. */
    alerts: z.enum(['enabled', 'disabled', 'unknown', 'none']),
    /** Open blind spots on the deployment or its repos. */
    blindSpots: z.array(blindSpotTypeSchema),
    /** No open blind spot, and a repo is mapped (databases need none). */
    covered: z.boolean(),
    /**
     * No git source: a service from a template or an app deployed from a registry
     * image. Not a blind spot; the phase 2 image scan will cover it.
     */
    imageOnly: z.boolean(),
  }),
  /** Advisory findings not fixed, by effective severity. */
  openFindings: severityCountsSchema,
  /** Exposed advisories on it (critical or high, runtime, public), not fixed or dismissed upstream. */
  exposed: z.number().int(),
  /** Blind spots not fixed on it or its repos. */
  openBlindSpots: z.number().int(),
})
export type DeploymentItem = z.infer<typeof deploymentItemSchema>

export const deploymentsResponseSchema = z.object({ items: z.array(deploymentItemSchema) })
export type DeploymentsResponse = z.infer<typeof deploymentsResponseSchema>

export const deploymentDetailSchema = deploymentItemSchema.extend({
  watchPaths: z.array(z.string()).nullable(),
  overrides: z.array(repoOverrideSchema),
  /** Findings that reach this deployment and are not fixed, most urgent first. */
  findings: z.array(findingListItemSchema),
})
export type DeploymentDetail = z.infer<typeof deploymentDetailSchema>

/** One deploy of an app as its deployment source reports it. */
export const deployRecordSchema = z.object({
  id: z.string(),
  status: z.string(),
  /** Git commit sha, null for image deploys or when the source does not say. */
  commit: z.string().nullable(),
  commitMessage: z.string().nullable(),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  /** Triggered by a git push webhook. */
  webhook: z.boolean(),
  rollback: z.boolean(),
})
export type DeployRecord = z.infer<typeof deployRecordSchema>

export const deploymentDeploysQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

/**
 * Recent deploys of a deployment, read live from its source. `available` is false when the
 * source cannot list them (services and databases, or the source is unreachable).
 */
export const deploymentDeploysResponseSchema = z.object({
  available: z.boolean(),
  /** Why the list is empty when `available` is false. */
  reason: z.string().nullable(),
  items: z.array(deployRecordSchema),
})
export type DeploymentDeploysResponse = z.infer<typeof deploymentDeploysResponseSchema>

/** `owner/name` as on GitHub. */
export const repoFullNameSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Must be owner/name')

export const addRepoOverrideRequestSchema = z.strictObject({
  repo: repoFullNameSchema,
  note: z.string().trim().max(300).nullable().optional(),
})
export type AddRepoOverrideRequest = z.infer<typeof addRepoOverrideRequestSchema>

export const repoOverridesResponseSchema = z.object({ items: z.array(repoOverrideSchema) })

export const repoOverrideParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  repoId: z.coerce.number().int().positive(),
})

export const reposResponseSchema = z.object({ items: z.array(repoRefSchema) })

// ---------------------------------------------------------------------------
// Settings

export const SCAN_INTERVAL_MIN_MINUTES = 15
export const SCAN_INTERVAL_MAX_MINUTES = 7 * 24 * 60
export const SCAN_INTERVAL_DEFAULT_MINUTES = 6 * 60

export const settingsSchema = z.object({
  scanIntervalMinutes: z
    .number()
    .int()
    .min(SCAN_INTERVAL_MIN_MINUTES)
    .max(SCAN_INTERVAL_MAX_MINUTES),
  osvEnabled: z.boolean(),
  includeAccountRepos: z.boolean(),
})
export type SettingsDto = z.infer<typeof settingsSchema>

export const updateSettingsRequestSchema = z
  .strictObject(settingsSchema.partial().shape)
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>

// ---------------------------------------------------------------------------
// Scans

export const scansQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const scansResponseSchema = z.object({ items: z.array(scanRunSchema) })

export const startScanResponseSchema = z.object({
  /** False when a scan was already running: `run` is that scan. */
  started: z.boolean(),
  run: scanRunSchema,
})
export type StartScanResponse = z.infer<typeof startScanResponseSchema>

// ---------------------------------------------------------------------------
// Shell

export const navCountsSchema = z.object({
  /** Exposed findings with no snooze or accepted risk in force. Shown as the hot badge. */
  needsAction: z.number().int().nullable(),
  deployments: z.number().int().nullable(),
  /** Findings not fixed, advisories and blind spots. */
  alerts: z.number().int().nullable(),
  /** Fix runs not yet verified fixed. Null until fix runs exist. */
  activeFixRuns: z.number().int().nullable(),
})
export type NavCountsDto = z.infer<typeof navCountsSchema>

/**
 * The steps of one scan, in order: read deployments from Coolify (and the
 * account repo list), fetch GitHub health and Dependabot alerts per repo,
 * scan lockfiles with OSV.dev per repo, match advisories to deployments, and
 * rank (blind spots and the final tally).
 */
export const SCAN_PHASES = ['deployments', 'alerts', 'lockfiles', 'matching', 'ranking'] as const
export const scanPhaseSchema = z.enum(SCAN_PHASES)
export type ScanPhase = z.infer<typeof scanPhaseSchema>

export const scanStatusSchema = z.discriminatedUnion('state', [
  /** No Coolify or GitHub source connected yet (first run). */
  z.object({ state: z.literal('unconfigured') }),
  /** Connected but never scanned: the first scan is about to start. */
  z.object({ state: z.literal('queued'), nextScanAt: isoDate.nullable() }),
  z.object({ state: z.literal('idle'), lastScanAt: isoDate, nextScanAt: isoDate.nullable() }),
  z.object({
    state: z.literal('scanning'),
    scanRunId: id,
    startedAt: isoDate,
    phase: scanPhaseSchema,
    /**
     * Progress inside the phase: Coolify instances (plus the account repo
     * list) while reading deployments, repos in alerts, lockfiles and
     * matching. 0 of 0 when the phase has no units (ranking) or none are known yet.
     */
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** Phases this scan leaves out, for example lockfiles while OSV.dev is off. */
    skipped: z.array(scanPhaseSchema),
  }),
  z.object({ state: z.literal('failed'), lastScanAt: isoDate.nullable(), message: z.string() }),
])
export type ScanStatusDto = z.infer<typeof scanStatusSchema>

// ---------------------------------------------------------------------------
// Notifications

export const NOTIFY_CHANNEL_KINDS = ['discord', 'webhook', 'email'] as const

/** How the SMTP connection is secured: implicit TLS, STARTTLS (required), or whatever the server offers. */
export const SMTP_SECURITY_MODES = ['tls', 'starttls', 'none'] as const
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number]

/** SMTP settings of an email channel as the API shows them: the password is never included. */
export const emailChannelViewSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  security: z.enum(SMTP_SECURITY_MODES),
  user: z.string().nullable(),
  from: z.string(),
  to: z.array(z.string()),
  /** True when a password is stored. The password itself is never returned. */
  passwordSet: z.boolean(),
})
export type EmailChannelView = z.infer<typeof emailChannelViewSchema>

/**
 * A notification channel. The webhook URL is always masked (origin and last four characters).
 * An email channel has no URL: `url` is `host:port` and `email` carries the settings.
 */
export const notifyChannelSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTIFY_CHANNEL_KINDS),
  name: z.string(),
  enabled: z.boolean(),
  /** Least severe finding the channel hears about. */
  minSeverity: severitySchema,
  url: z.string(),
  /** False when the URL (or the SMTP password) is stored in clear text because HINOMI_SECRET_KEY is not set. */
  urlEncrypted: z.boolean(),
  /** Present on email channels only. */
  email: emailChannelViewSchema.optional(),
})
export type NotifyChannel = z.infer<typeof notifyChannelSchema>

export const notifyChannelsResponseSchema = z.object({ items: z.array(notifyChannelSchema) })

export const channelParamSchema = z.object({ id: z.uuid() })

const webhookUrl = z.string().trim().min(1).max(1000)

const smtpHost = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9.:-]+$/, 'The SMTP host is a host name or an IP address')
const emailAddress = z.string().trim().max(254).pipe(z.email())
const smtpFields = {
  host: smtpHost,
  port: z.number().int().min(1).max(65535),
  security: z.enum(SMTP_SECURITY_MODES),
  user: z.string().trim().max(255),
  /** Empty or omitted: no authentication. */
  password: z.string().max(1000),
  from: emailAddress,
  to: z.array(emailAddress).min(1).max(20),
}

/** SMTP settings to create an email channel. */
export const emailChannelInputSchema = z.strictObject({
  host: smtpFields.host,
  port: smtpFields.port,
  security: smtpFields.security,
  user: smtpFields.user.optional(),
  password: smtpFields.password.optional(),
  from: smtpFields.from,
  to: smtpFields.to,
})
export type EmailChannelInput = z.infer<typeof emailChannelInputSchema>

/** A change to the SMTP settings. An omitted password stays; an empty one removes it. */
export const emailChannelPatchSchema = z
  .strictObject({
    host: smtpFields.host,
    port: smtpFields.port,
    security: smtpFields.security,
    user: smtpFields.user,
    password: smtpFields.password,
    from: smtpFields.from,
    to: smtpFields.to,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type EmailChannelPatch = z.infer<typeof emailChannelPatchSchema>

/** Discord and webhook channels need `url`; an email channel needs `email` and has no `url`. */
export const createNotifyChannelRequestSchema = z
  .strictObject({
    kind: z.enum(NOTIFY_CHANNEL_KINDS),
    name: z.string().trim().min(1).max(80),
    url: webhookUrl.optional(),
    email: emailChannelInputSchema.optional(),
    enabled: z.boolean().optional(),
    minSeverity: severitySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'email') {
      if (!value.email)
        ctx.addIssue({ code: 'custom', path: ['email'], message: 'The SMTP settings are required' })
      if (value.url !== undefined)
        ctx.addIssue({ code: 'custom', path: ['url'], message: 'An email channel has no URL' })
      return
    }
    if (value.url === undefined)
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'The webhook URL is required' })
    if (value.email !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'Only an email channel has SMTP settings',
      })
  })
export type CreateNotifyChannelRequest = z.infer<typeof createNotifyChannelRequestSchema>

export const updateNotifyChannelRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    url: webhookUrl.optional(),
    email: emailChannelPatchSchema.optional(),
    enabled: z.boolean().optional(),
    minSeverity: severitySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateNotifyChannelRequest = z.infer<typeof updateNotifyChannelRequestSchema>

export const notifyChannelTestResultSchema = z.object({
  ok: z.boolean(),
  /** Why the test message failed. Never contains the webhook URL or the SMTP password. */
  error: z.string().optional(),
})
export type NotifyChannelTestResult = z.infer<typeof notifyChannelTestResultSchema>

export const notifySettingsSchema = z.object({
  /** Public address of this Hinomi for links in messages, null when not set. */
  publicBaseUrl: z.string().nullable(),
  /** Hour of the day (0 to 23, server local time) the digest goes out. */
  digestHour: z.number().int().min(0).max(23),
})
export type NotifySettingsDto = z.infer<typeof notifySettingsSchema>

export const updateNotifySettingsRequestSchema = z
  .strictObject({
    /** An empty string clears it. */
    publicBaseUrl: z
      .string()
      .trim()
      .max(500)
      .regex(/^(https?:\/\/[^\s/?#]+[^\s]*)?$/i, 'Must be an http or https URL, or empty')
      .optional(),
    digestHour: z.number().int().min(0).max(23).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateNotifySettingsRequest = z.infer<typeof updateNotifySettingsRequestSchema>

// ---------------------------------------------------------------------------
// Onboarding

/** First run progress, kept on the server so every tab and browser agrees. */
export const onboardingStateSchema = z.object({
  /** The first scan finished. The / redirect stops sending people to setup. */
  finished: z.boolean(),
  /** The alerts step was skipped, so setup goes straight to the scan step. */
  alertsSkipped: z.boolean(),
})
export type OnboardingStateDto = z.infer<typeof onboardingStateSchema>

export const updateOnboardingRequestSchema = z
  .strictObject(onboardingStateSchema.partial().shape)
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateOnboardingRequest = z.infer<typeof updateOnboardingRequestSchema>
