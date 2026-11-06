import { z } from 'zod'

// Value sets of the core model (see docs/spec.md). The server stores these
// strings in SQLite; the API and the SPA validate against the same lists.
// The tuples are exported too, for drizzle column enums. Advisory severity
// lives in sources/osv.ts (advisorySeveritySchema), shared by both sources.

export const SOURCE_KINDS = ['coolify', 'github', 'osv'] as const
export const sourceKindSchema = z.enum(SOURCE_KINDS)
export type SourceKind = z.infer<typeof sourceKindSchema>

/** Sources that can report an advisory finding. */
export const REPORTERS = ['github', 'osv'] as const
export const reporterSchema = z.enum(REPORTERS)
export type Reporter = z.infer<typeof reporterSchema>

/** Dependency scope of a finding: shipped at runtime or only used in development. */
export const FINDING_SCOPES = ['runtime', 'dev', 'unknown'] as const
export const findingScopeSchema = z.enum(FINDING_SCOPES)
export type FindingScope = z.infer<typeof findingScopeSchema>

export const FINDING_STATES = ['open', 'fixing', 'fixed', 'snoozed', 'accepted'] as const
export const findingStateSchema = z.enum(FINDING_STATES)
export type FindingState = z.infer<typeof findingStateSchema>

/** An advisory on a repo, or a blind spot (missing coverage) on a repo or deployment. */
export const FINDING_KINDS = ['advisory', 'blind_spot'] as const
export const findingKindSchema = z.enum(FINDING_KINDS)
export type FindingKind = z.infer<typeof findingKindSchema>

export const BLIND_SPOT_TYPES = [
  'alerts_disabled',
  'archived_deployed',
  'no_repo_mapping',
  'lockfile_missing',
] as const
export const blindSpotTypeSchema = z.enum(BLIND_SPOT_TYPES)
export type BlindSpotType = z.infer<typeof blindSpotTypeSchema>

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
