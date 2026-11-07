import { z } from 'zod'

// Value sets of the core model (see docs/spec.md). The server stores these
// strings in SQLite; the API and the SPA validate against the same lists.
// The tuples are exported too, for drizzle column enums. Advisory severity
// lives in sources/osv.ts (advisorySeveritySchema), shared by both sources.

export const SOURCE_KINDS = ['coolify', 'github', 'osv'] as const
export const sourceKindSchema = z.enum(SOURCE_KINDS)
export type SourceKind = z.infer<typeof sourceKindSchema>

/**
 * How a source signs in. Coolify and GitHub tokens use `token`; GitHub can
 * also use `github_app` (App ID, installation ID and a private key).
 */
export const SOURCE_AUTHS = ['token', 'github_app'] as const
export const sourceAuthSchema = z.enum(SOURCE_AUTHS)
export type SourceAuth = z.infer<typeof sourceAuthSchema>

/**
 * Sources that can report an advisory finding. `image` is an image scan of what a
 * deployment runs (Coolify's own scan results, or an image SBOM checked on OSV).
 */
export const REPORTERS = ['github', 'osv', 'image'] as const
export const reporterSchema = z.enum(REPORTERS)
export type Reporter = z.infer<typeof reporterSchema>

/** Dependency scope of a finding: shipped at runtime or only used in development. */
export const FINDING_SCOPES = ['runtime', 'dev', 'unknown'] as const
export const findingScopeSchema = z.enum(FINDING_SCOPES)
export type FindingScope = z.infer<typeof findingScopeSchema>

/**
 * `dismissed_upstream`: GitHub dismissed the alert and no other source still
 * reports it. Shown like an accepted risk, never as fixed.
 */
export const FINDING_STATES = [
  'open',
  'fixing',
  'fixed',
  'snoozed',
  'accepted',
  'dismissed_upstream',
] as const
export const findingStateSchema = z.enum(FINDING_STATES)
export type FindingState = z.infer<typeof findingStateSchema>

/**
 * An advisory on a repo, a blind spot (missing coverage) on a repo or
 * deployment, a coverage note: something Hinomi does not check yet but
 * knows about (see COVERAGE_NOTE_TYPES), or a guard: a configuration or
 * support check on a deployment or repo (see GUARD_CHECKS in guards.ts).
 * Notes rank below every advisory.
 */
export const FINDING_KINDS = ['advisory', 'blind_spot', 'coverage_note', 'guard'] as const
export const findingKindSchema = z.enum(FINDING_KINDS)
export type FindingKind = z.infer<typeof findingKindSchema>

/**
 * Missing coverage on something deployed. `alerts_unknown` is a repo whose
 * Dependabot setting the token may not read (distinct from disabled);
 * `lockfile_unparseable` is a lockfile that was found but could not be read.
 */
export const BLIND_SPOT_TYPES = [
  'alerts_disabled',
  'alerts_unknown',
  'archived_deployed',
  'no_repo_mapping',
  'lockfile_missing',
  'lockfile_unparseable',
] as const
export const blindSpotTypeSchema = z.enum(BLIND_SPOT_TYPES)
export type BlindSpotType = z.infer<typeof blindSpotTypeSchema>

/**
 * Coverage notes. The type is part of the finding's dedupe key.
 * - `image_only`: a deployment with no git source (a service from a template,
 *   an app deployed from a registry image): there is no repo to map, and the
 *   image scan covers what it runs when it is on.
 * - `release_lockfile_missing`: a released desktop repo whose latest release
 *   tag has no lockfile Hinomi reads, so the version in users' hands is not checked.
 * - `requirements_unpinned`: a `requirements.txt` with lines that pin no exact
 *   version (ranges, URLs, editable installs); those lines are not checked.
 * - `image_scan_partial`: the image scan result of a deployment is partial (the
 *   scanner capped its list), so some advisories in the image may be missing.
 */
export const COVERAGE_NOTE_TYPES = [
  'image_only',
  'release_lockfile_missing',
  'requirements_unpinned',
  'image_scan_partial',
] as const
export const coverageNoteTypeSchema = z.enum(COVERAGE_NOTE_TYPES)
export type CoverageNoteType = z.infer<typeof coverageNoteTypeSchema>

/** How reachable a deployment is: a public domain, internal only, or unknown. */
export const DEPLOYMENT_REACHES = ['public', 'internal', 'unknown'] as const
export const deploymentReachSchema = z.enum(DEPLOYMENT_REACHES)
export type DeploymentReach = z.infer<typeof deploymentReachSchema>

export const SCAN_TRIGGERS = ['schedule', 'manual', 'boot'] as const
export const scanTriggerSchema = z.enum(SCAN_TRIGGERS)
export type ScanTrigger = z.infer<typeof scanTriggerSchema>

export const SCAN_RUN_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const
export const scanRunStatusSchema = z.enum(SCAN_RUN_STATUSES)
export type ScanRunStatus = z.infer<typeof scanRunStatusSchema>
