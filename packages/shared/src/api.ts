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
import { guardEvidenceSchema } from './guard-evidence.js'
import {
  guardCapabilitySchema,
  guardCheckSchema,
  guardLevelSchema,
  guardResultSchema,
  overridableCheckSchema,
} from './guards.js'
import { releaseTierModeSchema } from './releases.js'
import { deploymentKindSchema } from './sources/coolify.js'
import { severitySchema } from './sources/github.js'
import { advisorySeveritySchema } from './sources/osv.js'
import { nowMs } from './clock.js'
import { SUPPORT_WINDOW_MAX_DAYS, SUPPORT_WINDOW_MIN_DAYS } from './support.js'

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
 * Display tiers of the alerts list. Blind spots come first, then advisories and guards:
 * 1 exposed (critical or high, runtime, public), 2 deployed internal only,
 * 3 released (runtime dependencies of a desktop app's latest release, no deployment),
 * 4 deployed and public but moderate or low, 5 deployed dev dependencies,
 * 6 not deployed. Then advisories GitHub still reports although the lockfile is already
 * patched. Coverage notes (image only deployments, releases without a lockfile) and guards
 * at level `unknown` come last.
 * Within a tier rows keep their rank order.
 */
export const FINDING_TIERS = [
  'blind_spot',
  'exposed',
  'internal',
  'released',
  'public_low',
  'dev',
  'not_deployed',
  'patched',
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

/** A check override as a finding or a guard entry carries it. */
export const checkOverrideRefSchema = z.object({
  id,
  /** Turned off for this deployment, or for the whole repo. */
  scope: z.enum(['deployment', 'repo']),
  reason: z.string(),
  createdAt: isoDate,
})
export type CheckOverrideRef = z.infer<typeof checkOverrideRefSchema>

/** The guard part of a finding of kind `guard`. */
export const findingGuardSchema = z.object({
  check: guardCheckSchema,
  level: guardLevelSchema,
  evidence: guardEvidenceSchema,
  /** From GUARD_COPY, so every client shows the same words. */
  title: z.string(),
  explanation: z.string(),
  fixText: z.string(),
  /** Set when the check is turned off for the subject: the finding is then `accepted`. */
  override: checkOverrideRefSchema.nullable(),
})
export type FindingGuard = z.infer<typeof findingGuardSchema>

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
  /** GitHub's alert is still open but every version in the lockfile is patched. */
  patchedInLockfile: z.boolean(),
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
  /** Set for guard findings, null for every other kind. */
  guard: findingGuardSchema.nullable(),
  /** Desktop release advisories: the release tag that was scanned. Null otherwise. */
  releaseTag: z.string().nullable(),
  /**
   * Desktop release advisories: the default branch no longer has the vulnerable version, so a
   * patched release is due. The finding stays open, users still run the released build.
   */
  fixedOnDefaultBranch: z.boolean(),
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
  /** GitHub: the repos read and fixed through this source. 0 for other kinds. */
  repoCount: z.number().int().nonnegative(),
  /** Coolify: the deployments this source reports (removed with it). 0 for other kinds. */
  deploymentCount: z.number().int().nonnegative(),
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

// ---------------------------------------------------------------------------
// Fix plans: one upgrade plan per repo, built at the end of every scan

/**
 * Version of the fix plan contract. A runner that applies plans checks it and refuses a
 * version it does not know. Raised on any change that is not a new optional field.
 */
export const FIX_PLAN_VERSION = 1

/** Days a release must be public before a plan proposes it (the release age gate). */
export const RELEASE_AGE_GATE_DAYS = 7

/** Package managers a plan can target, detected from the lockfile name. */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'unknown'] as const
export const packageManagerSchema = z.enum(PACKAGE_MANAGERS)
export type PackageManager = z.infer<typeof packageManagerSchema>

/** Direct: a manifest lists the package. Transitive: only pulled in by other packages. */
export const dependencyRelationshipSchema = z.enum(['direct', 'transitive', 'unknown'])
export type DependencyRelationship = z.infer<typeof dependencyRelationshipSchema>

/** Semver distance from the installed version to the target; 0.x minors count as major. */
export const bumpLevelSchema = z.enum(['patch', 'minor', 'major', 'unknown'])
export type BumpLevel = z.infer<typeof bumpLevelSchema>

/**
 * Why a step is risky. semver_major: breaking by semver, read the changelog. pins_other_versions:
 * the override also moves copies of the package that were not vulnerable. unknown_version: the
 * versions are not semver. unknown_relationship: Hinomi could not tell direct from transitive.
 * unknown_package_manager: no lockfile Hinomi reads, so the step needs a person.
 */
export const fixPlanRiskReasonSchema = z.enum([
  'semver_major',
  'pins_other_versions',
  'unknown_version',
  'unknown_relationship',
  'unknown_package_manager',
])
export type FixPlanRiskReason = z.infer<typeof fixPlanRiskReasonSchema>

/** clear: older than the gate. too_new: inside it. unknown: the publish date is not known. */
export const releaseAgeSchema = z.enum(['clear', 'too_new', 'unknown'])
export type ReleaseAge = z.infer<typeof releaseAgeSchema>

/**
 * How a runner applies a step, without guessing:
 * - manifest_bump: set the dependency to `version` in each manifest (keep its range prefix),
 *   then install. For Cargo `manifests` is empty and the step's `workspaces` names the crates.
 * - override: set `key` to `value` under `field` of the root `manifest`, then install.
 *   `field` is `pnpm.overrides` (pnpm), `overrides` (npm, bun) or `resolutions` (yarn).
 * - lockfile_update: `cargo update -p <packageName>@<from> --precise <to>` for every `from`.
 * - manual: Hinomi does not know the package manager; a person applies it.
 */
export const fixPlanApplySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('manifest_bump'),
    manifests: z.array(z.string()),
    packageName: z.string(),
    version: z.string(),
  }),
  z.object({
    type: z.literal('override'),
    manifest: z.string(),
    field: z.enum(['pnpm.overrides', 'overrides', 'resolutions']),
    key: z.string(),
    value: z.string(),
  }),
  z.object({
    type: z.literal('lockfile_update'),
    tool: z.literal('cargo'),
    packageName: z.string(),
    from: z.array(z.string()),
    to: z.string(),
  }),
  z.object({ type: z.literal('manual') }),
])
export type FixPlanApply = z.infer<typeof fixPlanApplySchema>

/**
 * Counts per tier. Plans stored before a tier existed have no key for it, so a missing
 * tier reads as 0 instead of failing the whole plan.
 */
const tierCounts = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const counts: Record<string, unknown> = Object.fromEntries(FINDING_TIERS.map((t) => [t, 0]))
    return Object.assign(counts, value)
  },
  z.record(findingTierSchema, z.number().int()),
)

/** One project of the repo: a lockfile and the workspaces it covers. */
export const fixPlanProjectSchema = z.object({
  /** Repo relative lockfile path, e.g. `pnpm-lock.yaml` or `apps/api/Cargo.lock`. */
  lockfile: z.string(),
  /** Folder of the lockfile, `.` for the repo root. */
  root: z.string(),
  packageManager: packageManagerSchema,
  /** Workspaces seen in the lockfile: repo relative folders (npm family) or crate names (Cargo). */
  workspaces: z.array(z.string()),
})
export type FixPlanProject = z.infer<typeof fixPlanProjectSchema>

/** What a step or an unfixed entry is about: one package in one project. */
const fixPlanTargetFields = {
  /** Advisory ecosystem as Hinomi stores it (`npm`, `rust`, ...). */
  ecosystem: z.string(),
  packageName: z.string(),
  relationship: dependencyRelationshipSchema,
  /** The project's lockfile, null when no lockfile is known (GitHub reported a manifest only). */
  lockfile: z.string().nullable(),
  packageManager: packageManagerSchema,
  /** Where a direct dependency is declared, as in FixPlanProject.workspaces. Empty otherwise. */
  workspaces: z.array(z.string()),
  /** Direct dependencies that pull a transitive package in, from the lockfile paths. */
  via: z.array(z.string()),
  /** Open findings it covers, most urgent first. */
  findingIds: z.array(id),
  /** Advisory keys (GHSA or OSV ids) behind those findings. */
  advisories: z.array(z.string()),
  byTier: tierCounts,
}

/**
 * How the target of a step was checked against known advisories (OSV and GitHub data Hinomi
 * stores, plus an OSV query for the exact version). clean: no known advisory affects `to`.
 * affected: every version Hinomi knows in the step's semver line is affected, so `to` stays the
 * lowest version that clears the step's findings. unchecked: OSV could not answer (or is off),
 * so only stored advisories were checked.
 */
export const fixPlanTargetCheckSchema = z.object({
  status: z.enum(['clean', 'affected', 'unchecked']),
  /** Highest first patched version among the findings: what the step needs at least. */
  minimum: z.string(),
  /** Advisories that affect a lower candidate (such as `minimum`) and not `to`. */
  avoids: z.array(z.string()),
  /** Advisories known to affect `to` itself. Empty unless `status` is affected. */
  stillAffected: z.array(z.string()),
})
export type FixPlanTargetCheck = z.infer<typeof fixPlanTargetCheckSchema>

export const fixPlanStepSchema = z.object({
  /** Stable across scans: `apply type:ecosystem:package:to:lockfile`. */
  id: z.string(),
  /** 1 based position: safe direct bumps, then safe transitive fixes, then risky steps. */
  order: z.number().int().positive(),
  ...fixPlanTargetFields,
  /** Installed versions the step moves, lowest first. */
  from: z.array(z.string()),
  /**
   * Lowest version that clears every finding of the step and has no known advisory of its own,
   * within the semver line of the highest first patched version; see `targetCheck`.
   */
  to: z.string(),
  level: bumpLevelSchema,
  risk: z.enum(['safe', 'risky']),
  riskReasons: z.array(fixPlanRiskReasonSchema),
  /**
   * One line for the PR body, e.g. "Semver major: read the changelog", or what the target check
   * could not settle. Null when there is nothing to say.
   */
  note: z.string().nullable(),
  apply: fixPlanApplySchema,
  /** When `to` was published. Null: unknown (OSV and GitHub do not carry release dates). */
  releasedAt: isoDate.nullable(),
  releaseAge: releaseAgeSchema,
  /** The target check. Absent in plans built before it existed and for ecosystems it skips. */
  targetCheck: fixPlanTargetCheckSchema.optional(),
})
export type FixPlanStep = z.infer<typeof fixPlanStepSchema>

/** Findings no step can clear yet: `blocker` says why. too_new is kept for when release dates are known. */
export const fixPlanUnfixedSchema = z.object({
  ...fixPlanTargetFields,
  installed: z.array(z.string()),
  blocker: z.enum(['no_patch', 'too_new']),
  /** When a too_new release clears the gate. Null for no_patch or an unknown date. */
  availableAt: isoDate.nullable(),
})
export type FixPlanUnfixed = z.infer<typeof fixPlanUnfixedSchema>

export const fixPlanSummarySchema = z.object({
  findings: z.object({
    /** Open fixable findings of the repo when the plan was built. */
    total: z.number().int(),
    /** Findings the steps clear (safe and risky). */
    cleared: z.number().int(),
    /** Findings the safe steps alone clear. */
    clearedSafely: z.number().int(),
    unfixed: z.number().int(),
    clearedByTier: tierCounts,
    unfixedByTier: tierCounts,
  }),
  steps: z.object({ safe: z.number().int(), risky: z.number().int() }),
  /** Unfixed entries (packages), not findings. */
  unfixed: z.number().int(),
})
export type FixPlanSummary = z.infer<typeof fixPlanSummarySchema>

/** How the plan of the previous scan of the repo turned out by this scan. */
export const fixPlanPreviousSchema = z.object({
  scanRunId: id,
  /** Findings its steps covered. */
  findings: z.number().int(),
  /** Of those, fixed by now. */
  cleared: z.number().int(),
  /** Of those, still open by now. */
  stillOpen: z.number().int(),
})
export type FixPlanPrevious = z.infer<typeof fixPlanPreviousSchema>

/**
 * One upgrade plan per repo and scan: every open fixable finding is either in a step or in
 * `unfixed`. Serialisable as is; a runner applies `steps` in `order` in one branch and one PR.
 */
export const fixPlanSchema = z.object({
  version: z.literal(FIX_PLAN_VERSION),
  repo: repoRefSchema,
  scanRunId: id,
  createdAt: isoDate,
  projects: z.array(fixPlanProjectSchema),
  steps: z.array(fixPlanStepSchema),
  unfixed: z.array(fixPlanUnfixedSchema),
  summary: fixPlanSummarySchema,
  previous: fixPlanPreviousSchema.nullable(),
})
export type FixPlan = z.infer<typeof fixPlanSchema>

/** A link to a repo's latest plan with its summary, for lists and finding detail. */
export const fixPlanRefSchema = z.object({
  repoId: id,
  scanRunId: id,
  createdAt: isoDate,
  summary: fixPlanSummarySchema,
})
export type FixPlanRef = z.infer<typeof fixPlanRefSchema>

/** Query of GET /api/repos/:id/plan. Without `scan`, the latest plan. */
export const fixPlanQuerySchema = z.strictObject({
  scan: z.coerce.number().int().positive().optional(),
})

export const fixPlansResponseSchema = z.object({
  /** The latest plan of every repo that has one, most findings cleared first. */
  items: z.array(fixPlanRefSchema.extend({ repo: repoRefSchema })),
})
export type FixPlansResponse = z.infer<typeof fixPlansResponseSchema>

// ---------------------------------------------------------------------------
// Fixes: open findings grouped by the version bump that clears them

export const FIXES_PAGE_MAX = 100

/** How many fixes the overview lists. */
export const TOP_FIXES = 5

/** Query of GET /api/fixes. The filters narrow the findings before they are grouped. */
export const fixesQuerySchema = z.strictObject({
  /** Repo ids. */
  repo: csvIds.optional(),
  /** Deployment (app) ids. */
  deployment: csvIds.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(FIXES_PAGE_MAX).default(25),
})
export type FixesQuery = z.input<typeof fixesQuerySchema>

/** What one fix means for one repo: the version that repo needs and how much it clears there. */
export const fixRepoSchema = z.object({
  repo: repoRefSchema,
  /** Lowest version that clears every advisory of the package in this repo. Null: no patch yet. */
  target: z.string().nullable(),
  findings: z.number().int(),
  /** The repo's latest fix plan, null until a scan has built one. */
  plan: fixPlanRefSchema.nullable(),
  /**
   * The target that plan's step for the package picked and how it was checked against known
   * advisories. Null when the plan has no step for the package or did not check its target.
   */
  planTarget: fixPlanTargetCheckSchema.extend({ to: z.string() }).nullable().optional(),
})
export type FixRepo = z.infer<typeof fixRepoSchema>

/**
 * One bump: the open advisory findings of a package that a single upgrade clears. `target` is
 * the highest version any repo needs, so installing it clears everything listed. The fix with
 * a null `target` holds the findings of the package that have no patched version yet.
 */
export const fixItemSchema = z.object({
  /** Stable key: `ecosystem:package:target`, with `none` as the target when there is no patch. */
  key: z.string(),
  ecosystem: z.string(),
  packageName: z.string(),
  target: z.string().nullable(),
  /** Repos need different target versions; see `repos`. Always false without a target. */
  mixedTargets: z.boolean(),
  /** Findings the bump clears, and how they split by display tier and by effective severity. */
  findings: z.object({
    total: z.number().int(),
    byTier: z.record(findingTierSchema, z.number().int()),
    bySeverity: severityCountsSchema,
  }),
  /** Ids of those findings, most urgent first. */
  findingIds: z.array(id),
  /** Most urgent tier among the findings, in FINDING_TIERS order. */
  bestTier: findingTierSchema,
  /** At least one finding is critical on an app that is reachable from the internet. */
  exposedCritical: z.boolean(),
  /** Repos behind the fix, each with the version it needs. Most findings first. */
  repos: z.array(fixRepoSchema),
  /** Apps (deployments) the findings reach. */
  apps: z.array(deploymentRefSchema),
})
export type FixItem = z.infer<typeof fixItemSchema>

export const fixesResponseSchema = z.object({
  items: z.array(fixItemSchema),
  /** Fixes matching the filters, over every page. */
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  /** Offset of the next page, null on the last one. */
  nextOffset: z.number().int().nullable(),
})
export type FixesResponse = z.infer<typeof fixesResponseSchema>

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
  /** The fixes with a patched version that clear the most exposure, at most 5, same order as /api/fixes. */
  topFixes: z.array(fixItemSchema),
  /** Guard findings not fixed (turned off ones included), per check and level. */
  guardCounts: z.record(guardCheckSchema, z.record(guardLevelSchema, z.number().int())),
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
  /** Guard checks. Only guard findings match. */
  check: csvOf(guardCheckSchema).optional(),
  /** Guard levels. Only guard findings match. */
  level: csvOf(guardLevelSchema).optional(),
  /** true: only desktop release findings; false: none of them. */
  release: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
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
  /**
   * Open findings the same bump clears, this one included (across repos, like /api/fixes).
   * 0 when the finding is not part of a fix: not open, patched in the lockfile, or not an advisory.
   */
  sameFixClears: z.number().int(),
  /** The latest fix plan of the finding's repo, null without a repo or before a plan exists. */
  plan: fixPlanRefSchema.nullable(),
  /** Decision and scan history, newest first. */
  history: z.array(findingEventSchema),
  /** Notifications sent about it, newest first. Daily digests are not recorded per finding. */
  notifications: z.array(findingNotificationSchema),
})
export type FindingDetail = z.infer<typeof findingDetailSchema>

const reason = z.string().trim().min(1, 'A reason is required').max(500)

const futureDate = isoDate.refine((value) => Date.parse(value) > nowMs(), {
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

/**
 * One check on one deployment, for the deployment's guards panel. Blind spot types that
 * can be turned off (like `archived_deployed`) are listed here too.
 */
export const deploymentGuardSchema = z.object({
  check: overridableCheckSchema,
  /** `pass`, a level, or null when the check has not run on it yet. */
  result: guardResultSchema.nullable(),
  /** Null for a pass without evidence, and for blind spot types. */
  evidence: guardEvidenceSchema.nullable(),
  /** The open finding, null on a pass. */
  findingId: id.nullable(),
  override: checkOverrideRefSchema.nullable(),
})
export type DeploymentGuard = z.infer<typeof deploymentGuardSchema>

export const deploymentDetailSchema = deploymentItemSchema.extend({
  watchPaths: z.array(z.string()).nullable(),
  overrides: z.array(repoOverrideSchema),
  /** Findings that reach this deployment and are not fixed, most urgent first. */
  findings: z.array(findingListItemSchema),
  /** One entry per guard check, then the blind spot types that can be turned off (see deploymentGuardSchema). */
  guards: z.array(deploymentGuardSchema),
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

/**
 * How a repo's GitHub source was chosen. override: picked by hand. auto: the scan's rule (the
 * lowest id source that can read its alerts, else the lowest id source that can read it).
 * fallback: no scan has chosen yet and only one GitHub source is connected. none: no connected
 * GitHub source can read the repo.
 */
export const REPO_SOURCE_MODES = ['override', 'auto', 'fallback', 'none'] as const
export const repoSourceModeSchema = z.enum(REPO_SOURCE_MODES)
export type RepoSourceMode = z.infer<typeof repoSourceModeSchema>

/** A GitHub source as a repo sees it. */
export const repoSourceRefSchema = z.object({
  id,
  name: z.string(),
  auth: sourceAuthSchema,
  enabled: z.boolean(),
})
export type RepoSourceRef = z.infer<typeof repoSourceRefSchema>

/** A GitHub source that saw the repo on the last scan that asked it. */
export const repoSourceSeenSchema = repoSourceRefSchema.extend({
  /** The source could tell whether the repo's Dependabot alerts are on. Null when unknown. */
  alertsReadable: z.boolean().nullable(),
  lastSeenAt: isoDate,
})
export type RepoSourceSeen = z.infer<typeof repoSourceSeenSchema>

export const repoSourceViewSchema = z.object({
  /** The GitHub source that reads and fixes the repo. Null when mode is none. */
  current: repoSourceRefSchema.nullable(),
  mode: repoSourceModeSchema,
  /** The source picked by hand, also while it is switched off (then it does not apply). */
  overrideId: id.nullable(),
  /** GitHub sources that saw the repo, lowest id first. More than one: the source can be switched. */
  seenBy: z.array(repoSourceSeenSchema),
})
export type RepoSourceView = z.infer<typeof repoSourceViewSchema>

/**
 * Where a repo stands in the desktop release tier. released: its latest release counts as in
 * users' hands and is scanned. deployed: a deployment exists (stopped ones too), so it keeps its
 * deploy tiers. turned_off: the repo's mode is `off`. no_release: GitHub has no final release.
 * no_installers: the latest release has no installer like asset (mode `auto`). not_checked: the
 * daily release check has not run for it yet (Hinomi scans it only when nothing deploys it and
 * account repos are scanned).
 */
export const REPO_RELEASE_STATUSES = [
  'released',
  'deployed',
  'turned_off',
  'no_release',
  'no_installers',
  'not_checked',
] as const
export const repoReleaseStatusSchema = z.enum(REPO_RELEASE_STATUSES)
export type RepoReleaseStatus = z.infer<typeof repoReleaseStatusSchema>

/** The latest final release of a repo and its desktop tier, as GET /api/repos/:id serves it. */
export const repoReleaseSchema = z.object({
  /** The per repo mode (`auto` unless changed). */
  tier: releaseTierModeSchema,
  status: repoReleaseStatusSchema,
  /** Tag of the latest release that is neither a draft nor a prerelease. Null: none or not checked. */
  latestTag: z.string().nullable(),
  latestAt: isoDate.nullable(),
  /** The latest release has installer like assets. Null until checked. */
  installers: z.boolean().nullable(),
  /** The asset names that look installable (at most 50). */
  installerAssets: z.array(z.string()),
  /** When the daily release check last asked GitHub. */
  checkedAt: isoDate.nullable(),
  /** Open advisories found at the latest tag. */
  openFindings: z.number().int().nonnegative(),
  /** Of those, fixed on the default branch but not released yet: a patched release is due. */
  fixedOnDefaultBranch: z.number().int().nonnegative(),
  /** The latest tag has no lockfile Hinomi reads, so the released version is not checked. */
  lockfileMissing: z.boolean(),
})
export type RepoRelease = z.infer<typeof repoReleaseSchema>

/** GET /api/repos/:id. */
export const repoDetailSchema = repoRefSchema.extend({
  source: repoSourceViewSchema,
  release: repoReleaseSchema,
})
export type RepoDetail = z.infer<typeof repoDetailSchema>

/**
 * PUT /api/repos/:id/release-tier: the repo's desktop tier mode. `on` and `off` override the
 * installer heuristic; `auto` goes back to it. Answers the repo detail.
 */
export const updateRepoReleaseTierRequestSchema = z.strictObject({ tier: releaseTierModeSchema })
export type UpdateRepoReleaseTierRequest = z.infer<typeof updateRepoReleaseTierRequestSchema>

/** PATCH /api/repos/:id. A GitHub source id picks the repo's source by hand; null clears it. */
export const updateRepoRequestSchema = z.strictObject({ sourceId: id.nullable() })
export type UpdateRepoRequest = z.infer<typeof updateRepoRequestSchema>

// ---------------------------------------------------------------------------
// Guards and check overrides

/** A check turned off with a reason, for one deployment or one repo. */
export const checkOverrideSchema = z.object({
  id,
  check: overridableCheckSchema,
  /** Exactly one of `deployment` and `repo` is set. */
  deployment: deploymentRefSchema.nullable(),
  repo: repoRefSchema.nullable(),
  reason: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type CheckOverride = z.infer<typeof checkOverrideSchema>

/** Query of GET /api/overrides. */
export const checkOverridesQuerySchema = z.strictObject({
  check: csvOf(overridableCheckSchema).optional(),
  /** Deployment ids. */
  deployment: csvIds.optional(),
  /** Repo ids. */
  repo: csvIds.optional(),
})
export type CheckOverridesQuery = z.input<typeof checkOverridesQuerySchema>

export const checkOverridesResponseSchema = z.object({ items: z.array(checkOverrideSchema) })
export type CheckOverridesResponse = z.infer<typeof checkOverridesResponseSchema>

/** POST /api/overrides: turn a check off for one deployment or one repo, with a reason. */
export const createCheckOverrideRequestSchema = z
  .strictObject({
    check: overridableCheckSchema,
    deploymentId: id.optional(),
    repoId: id.optional(),
    reason,
  })
  .refine((value) => (value.deploymentId === undefined) !== (value.repoId === undefined), {
    message: 'Give either deploymentId or repoId',
    path: ['deploymentId'],
  })
export type CreateCheckOverrideRequest = z.infer<typeof createCheckOverrideRequestSchema>

/** PATCH /api/overrides/:id: only the reason can change. */
export const updateCheckOverrideRequestSchema = z.strictObject({ reason })
export type UpdateCheckOverrideRequest = z.infer<typeof updateCheckOverrideRequestSchema>

/** One check in the registry of GET /api/guards. */
export const guardInfoSchema = z.object({
  check: guardCheckSchema,
  title: z.string(),
  /** What the check reads. */
  reads: z.string(),
  /** Levels the check can produce. */
  levels: z.array(guardLevelSchema),
  /** How much of the check each connected kind of deployment source can answer. */
  capabilities: z.partialRecord(sourceKindSchema, guardCapabilitySchema),
  /** Open (not fixed) findings per level. */
  counts: z.record(guardLevelSchema, z.number().int()),
  /** Active overrides of this check. */
  overrides: z.number().int(),
})
export type GuardInfo = z.infer<typeof guardInfoSchema>

export const guardsResponseSchema = z.object({ items: z.array(guardInfoSchema) })
export type GuardsResponse = z.infer<typeof guardsResponseSchema>

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
  /** The daily look at the latest GitHub release. On unless switched off. */
  updateCheckEnabled: z.boolean(),
  /** Days before end of life at which a support window turns to a warning. */
  supportWindowDays: z.number().int().min(SUPPORT_WINDOW_MIN_DAYS).max(SUPPORT_WINDOW_MAX_DAYS),
})
export type SettingsDto = z.infer<typeof settingsSchema>

export const updateSettingsRequestSchema = z
  .strictObject(settingsSchema.partial().shape)
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>

// ---------------------------------------------------------------------------
// Version

/** A newer final release than the running build (or a newer pre-release, for a pre-release build). */
export const availableUpdateSchema = z.object({
  /** Without the leading v, like `version`. */
  version: z.string(),
  /** The release notes page. */
  url: z.string(),
  /** The image tag to pull, for example `ghcr.io/shironex/hinomi:0.3.1`. */
  imageTag: z.string(),
})
export type AvailableUpdate = z.infer<typeof availableUpdateSchema>

/**
 * GET /api/version. `version` is `dev` for a build without a release version; `commit` is the full
 * git sha and `buildDate` an ISO timestamp, both null when the build did not say. `imageTag` and
 * `releaseNotesUrl` are null for a dev build. `update` is null when the check is off, found
 * nothing newer, or could not reach GitHub.
 */
export const versionResponseSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  buildDate: z.string().nullable(),
  isDev: z.boolean(),
  prerelease: z.boolean(),
  imageTag: z.string().nullable(),
  releaseNotesUrl: z.string().nullable(),
  update: availableUpdateSchema.nullable(),
})
export type VersionResponse = z.infer<typeof versionResponseSchema>

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
  /** Guard findings at warn or fail on a running deployment, not snoozed, accepted or turned off. */
  guards: z.number().int().nullable(),
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

/**
 * Fix run events a notification can announce, one switch each:
 * `prOpened` (the fix PR is open, with its draft state), `checksFailing` (the PR checks
 * failed), `verified` (the rescan found every targeted finding gone), `notCleared` (the rescan
 * left some open), `failed` (the run failed, was lost or was cancelled) and `warnings` (a
 * merged run's `watch_paths_skip` or `deploy_not_seen`).
 */
export const FIX_RUN_NOTIFY_EVENTS = [
  'prOpened',
  'checksFailing',
  'verified',
  'notCleared',
  'failed',
  'warnings',
] as const
export type FixRunNotifyEvent = (typeof FIX_RUN_NOTIFY_EVENTS)[number]

export const fixRunNotifyEventsSchema = z.object({
  prOpened: z.boolean(),
  checksFailing: z.boolean(),
  verified: z.boolean(),
  notCleared: z.boolean(),
  failed: z.boolean(),
  warnings: z.boolean(),
})
export type FixRunNotifyEvents = z.infer<typeof fixRunNotifyEventsSchema>

/** Every fix run event is announced until switched off. */
export const DEFAULT_FIX_RUN_NOTIFY_EVENTS: FixRunNotifyEvents = {
  prOpened: true,
  checksFailing: true,
  verified: true,
  notCleared: true,
  failed: true,
  warnings: true,
}

export const notifySettingsSchema = z.object({
  /** Public address of this Hinomi for links in messages, null when not set. */
  publicBaseUrl: z.string().nullable(),
  /** Hour of the day (0 to 23, server local time) the digest goes out. */
  digestHour: z.number().int().min(0).max(23),
  /** Which fix run events are announced on the enabled channels. */
  fixRunEvents: fixRunNotifyEventsSchema.default(DEFAULT_FIX_RUN_NOTIFY_EVENTS),
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
    /** Switches to change; the events left out keep their value. */
    fixRunEvents: z
      .strictObject(fixRunNotifyEventsSchema.partial().shape)
      .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
      .optional(),
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
