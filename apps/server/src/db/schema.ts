import {
  BLIND_SPOT_TYPES,
  DEPLOYMENT_REACHES,
  FINDING_KINDS,
  FINDING_SCOPES,
  FINDING_STATES,
  FIX_RUN_KINDS,
  RUNNER_MAJORS_AGENTS,
  FIX_RUN_STATES,
  FIX_RUNNER_KINDS,
  SCAN_RUN_STATUSES,
  SCAN_TRIGGERS,
  SOURCE_AUTHS,
  SOURCE_KINDS,
  type AdvisorySeverity,
  type DeploymentKind,
  type FixChecksMode,
  type FixPlan,
  type FixResultV1,
  type FixRunDeployment,
  type FixRunVerification,
  type FixRunWarning,
  type Reporter,
  type SourceKind,
  currentTime,
} from '@hinomi/shared'
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// Conventions:
// - Integer autoincrement ids, timestamps as unix milliseconds (`Date` in TS).
// - Enum-like columns are text constrained in TypeScript by the shared zod enums.
// - JSON columns are text with a typed shape.
// - Repo owner and name are stored lowercased (GitHub treats them case-insensitively).

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`
const createdAt = () => timestamp('created_at').notNull().default(nowMs)
const updatedAt = () =>
  timestamp('updated_at')
    .notNull()
    .default(nowMs)
    .$onUpdate(() => currentTime())

/** A connected integration: a Coolify instance, a GitHub account, OSV.dev. */
export const sources = sqliteTable(
  'sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: SOURCE_KINDS }).notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url'),
    /**
     * AES-256-GCM ciphertext (see crypto/secret-box.ts) of the source's secret: the API
     * token, or the private key PEM of a GitHub App. Never leaves the server.
     */
    tokenEncrypted: text('token_encrypted'),
    /** token, or github_app for GitHub sources signing in as a GitHub App. */
    auth: text('auth', { enum: SOURCE_AUTHS }).notNull().default('token'),
    /** GitHub App ID or Client ID (the JWT issuer). Null for token auth. */
    appId: text('app_id'),
    /** GitHub App installation ID. Null for token auth. */
    installationId: text('installation_id'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastOkAt: timestamp('last_ok_at'),
    lastErrorAt: timestamp('last_error_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sources_kind_name_unique').on(t.kind, t.name)],
)

/** A GitHub repository, whether or not anything deploys it. */
export const repos = sqliteTable(
  'repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    /** Dependabot alerts switched on. Null until GitHub has been asked. */
    alertsEnabled: integer('alerts_enabled', { mode: 'boolean' }),
    lastScannedAt: timestamp('last_scanned_at'),
    /** The GitHub Actions fix runner may dispatch fix plans for this repo. Off until turned on. */
    runnerEnabled: integer('runner_enabled', { mode: 'boolean' }).notNull().default(false),
    /** Caller workflow file under .github/workflows. Null means DEFAULT_CALLER_WORKFLOW. */
    runnerWorkflow: text('runner_workflow'),
    /** The coding agent the optional majors job runs. Off until turned on. */
    runnerMajorsAgent: text('runner_majors_agent', { enum: RUNNER_MAJORS_AGENTS })
      .notNull()
      .default('off'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('repos_owner_name_unique').on(t.owner, t.name)],
)

/** One running app (application, service or database) reported by a deployment source. */
export const deployments = sqliteTable(
  'deployments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /** The id the source uses for this deployment (a Coolify uuid). */
    externalId: text('external_id').notNull(),
    kind: text('kind').$type<DeploymentKind>().notNull(),
    name: text('name').notNull(),
    domains: text('domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
    reach: text('reach', { enum: DEPLOYMENT_REACHES }).notNull().default('unknown'),
    server: text('server'),
    status: text('status'),
    image: text('image'),
    /**
     * Git repository as `owner/name`, or as the source reports it when that
     * cannot be parsed. Null when the deployment has no git source at all.
     */
    gitRepository: text('git_repository'),
    gitBranch: text('git_branch'),
    /** Watch paths for monorepos, null when the source does not expose them. */
    watchPaths: text('watch_paths', { mode: 'json' }).$type<string[]>(),
    /** Repo mapped automatically from gitRepository. Manual overrides live in deployment_repo_overrides. */
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    lastDeployedAt: timestamp('last_deployed_at'),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('deployments_source_external_unique').on(t.sourceId, t.externalId),
    index('deployments_repo_idx').on(t.repoId),
  ],
)

/**
 * Manual repo mapping for a deployment (monorepos, renamed repos). When a
 * deployment has overrides they replace its automatic repoId.
 */
export const deploymentRepoOverrides = sqliteTable(
  'deployment_repo_overrides',
  {
    deploymentId: integer('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.deploymentId, t.repoId] }),
    index('deployment_repo_overrides_repo_idx').on(t.repoId),
  ],
)

/** A vulnerability advisory for one package in one ecosystem. */
export const advisories = sqliteTable(
  'advisories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Primary advisory id: the GHSA id when there is one, otherwise the OSV id. */
    advisoryKey: text('advisory_key').notNull(),
    ghsaId: text('ghsa_id'),
    cveIds: text('cve_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Other ids the advisory is known by (OSV aliases). */
    aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),
    ecosystem: text('ecosystem').notNull(),
    packageName: text('package_name').notNull(),
    severity: text('severity').$type<AdvisorySeverity>().notNull().default('unknown'),
    cvssScore: real('cvss_score'),
    cvssVector: text('cvss_vector'),
    summary: text('summary'),
    /** Long description from the source (markdown as written). */
    description: text('description'),
    url: text('url'),
    vulnerableRanges: text('vulnerable_ranges', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    firstPatchedVersion: text('first_patched_version'),
    publishedAt: timestamp('published_at'),
    withdrawnAt: timestamp('withdrawn_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('advisories_key_package_unique').on(t.advisoryKey, t.ecosystem, t.packageName),
    index('advisories_ghsa_idx').on(t.ghsaId),
  ],
)

/**
 * Something to act on: an advisory on a repo, or a blind spot (missing
 * coverage) on a repo or a deployment. `dedupeKey` keeps one row per subject;
 * see repository/findings.ts for how it is built.
 */
export const findings = sqliteTable(
  'findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind', { enum: FINDING_KINDS }).notNull(),
    advisoryId: integer('advisory_id').references(() => advisories.id, { onDelete: 'cascade' }),
    blindSpotType: text('blind_spot_type', { enum: BLIND_SPOT_TYPES }),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    /** Set for blind spots about a deployment itself (no repo mapping). */
    deploymentId: integer('deployment_id').references(() => deployments.id, {
      onDelete: 'cascade',
    }),
    scope: text('scope', { enum: FINDING_SCOPES }).notNull().default('unknown'),
    reportedBy: text('reported_by', { mode: 'json' }).$type<Reporter[]>().notNull().default([]),
    manifestPaths: text('manifest_paths', { mode: 'json' }).$type<string[]>().notNull().default([]),
    installedVersion: text('installed_version'),
    /**
     * GitHub still has an open alert, but every version the lockfile resolves is patched (an
     * override or resolution fixed it). Ranked below open advisories and never notified.
     */
    patchedInLockfile: integer('patched_in_lockfile', { mode: 'boolean' }).notNull().default(false),
    /** Package names from a direct dependency down to the vulnerable one, from a parsed lockfile. */
    dependencyPath: text('dependency_path', { mode: 'json' }).$type<string[]>(),
    state: text('state', { enum: FINDING_STATES }).notNull().default('open'),
    /** Why it was snoozed or accepted. */
    stateReason: text('state_reason'),
    /** When a snooze or acceptance expires. */
    stateUntil: timestamp('state_until'),
    /** The snooze or acceptance lasts until a new advisory shows up for the same package and repo. */
    stateUntilNewAdvisory: integer('state_until_new_advisory', { mode: 'boolean' })
      .notNull()
      .default(false),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    fixedAt: timestamp('fixed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('findings_dedupe_key_unique').on(t.dedupeKey),
    index('findings_repo_idx').on(t.repoId),
    index('findings_advisory_idx').on(t.advisoryId),
    index('findings_deployment_idx').on(t.deploymentId),
    index('findings_state_idx').on(t.state),
  ],
)

/** History of a finding: every state change, who made it, and why. */
export const findingEvents = sqliteTable(
  'finding_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    findingId: integer('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    /** What happened, for example opened, state_changed, fixed, reopened. */
    type: text('type').notNull(),
    fromState: text('from_state', { enum: FINDING_STATES }),
    toState: text('to_state', { enum: FINDING_STATES }),
    reason: text('reason'),
    until: timestamp('until'),
    /** `system` for scans and expiries, `user` for decisions made in the UI. */
    actor: text('actor', { enum: ['system', 'user'] })
      .notNull()
      .default('system'),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    at: timestamp('at').notNull(),
  },
  (t) => [index('finding_events_finding_idx').on(t.findingId, t.at)],
)

/** Outcome of one source within a scan run. */
export interface ScanSourceResult {
  status: 'ok' | 'error' | 'skipped'
  /** Source specific counters, for example { deployments: 12 } or { repos: 30, alerts: 210 }. */
  counts: Record<string, number>
  error?: string
  durationMs?: number
}

export const scanRuns = sqliteTable(
  'scan_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trigger: text('trigger', { enum: SCAN_TRIGGERS }).notNull(),
    status: text('status', { enum: SCAN_RUN_STATUSES }).notNull().default('running'),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    durationMs: integer('duration_ms'),
    /** Per source counts and errors, keyed by source kind. */
    sourceResults: text('source_results', { mode: 'json' })
      .$type<Partial<Record<SourceKind, ScanSourceResult>>>()
      .notNull()
      .default({}),
    findingsOpened: integer('findings_opened').notNull().default(0),
    findingsFixed: integer('findings_fixed').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('scan_runs_started_idx').on(t.startedAt)],
)

/**
 * The fix plan of one repo as one scan built it (see scan/plans.ts). `plan` holds the
 * versioned contract as served; the counts are copied out for cheap lists.
 */
export const fixPlans = sqliteTable(
  'fix_plans',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    scanRunId: integer('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    /** FIX_PLAN_VERSION the plan was built with. */
    version: integer('version').notNull(),
    plan: text('plan', { mode: 'json' }).$type<FixPlan>().notNull(),
    findingsCleared: integer('findings_cleared').notNull().default(0),
    safeSteps: integer('safe_steps').notNull().default(0),
    riskySteps: integer('risky_steps').notNull().default(0),
    unfixed: integer('unfixed').notNull().default(0),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('fix_plans_repo_scan_unique').on(t.repoId, t.scanRunId),
    index('fix_plans_scan_idx').on(t.scanRunId),
  ],
)

/**
 * One dispatch of a fix plan to a runner, tracked until a rescan verifies it (see
 * repository/fix-run-transitions.ts for the state machine). The plan is referenced by its row,
 * which survives plan pruning while the run is open, and by scan run and version, which survive
 * even after the row is gone.
 */
export const fixRuns = sqliteTable(
  'fix_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    fixPlanId: integer('fix_plan_id').references(() => fixPlans.id, { onDelete: 'set null' }),
    /** The scan that built the plan. No foreign key: it outlives scan run cleanup. */
    planScanRunId: integer('plan_scan_run_id').notNull(),
    planVersion: integer('plan_version').notNull(),
    runner: text('runner', { enum: FIX_RUNNER_KINDS }).notNull(),
    kind: text('kind', { enum: FIX_RUN_KINDS }).notNull(),
    /** Random id sent with the dispatch and in the run name, unique across runs. */
    correlationId: text('correlation_id').notNull(),
    branch: text('branch').notNull(),
    checksMode: text('checks_mode').$type<FixChecksMode>().notNull(),
    state: text('state', { enum: FIX_RUN_STATES }).notNull().default('pending'),
    stateReason: text('state_reason'),
    githubRunId: integer('github_run_id'),
    githubRunAttempt: integer('github_run_attempt'),
    headSha: text('head_sha'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    prDraft: integer('pr_draft', { mode: 'boolean' }).notNull().default(false),
    mergeSha: text('merge_sha'),
    /** The runner's result file once read and validated. */
    result: text('result', { mode: 'json' }).$type<FixResultV1>(),
    /** ETags of the last polls, sent back as If-None-Match. */
    runEtag: text('run_etag'),
    prEtag: text('pr_etag'),
    checksEtag: text('checks_etag'),
    /** The repo's Coolify applications after the merge. Null until the tracker looked. */
    deployLinks: text('deploy_links', { mode: 'json' }).$type<FixRunDeployment[]>(),
    /** Watch path and deploy wait warnings, as the API serves them. */
    warnings: text('warnings', { mode: 'json' }).$type<FixRunWarning[]>().notNull().default([]),
    /** The verification rescan and its comparison. Null until the run waits for one. */
    verification: text('verification', { mode: 'json' }).$type<FixRunVerification>(),
    createdAt: timestamp('created_at').notNull(),
    dispatchedAt: timestamp('dispatched_at'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    pushedAt: timestamp('pushed_at'),
    prOpenedAt: timestamp('pr_opened_at'),
    checksUpdatedAt: timestamp('checks_updated_at'),
    mergedAt: timestamp('merged_at'),
    closedAt: timestamp('closed_at'),
    deployedAt: timestamp('deployed_at'),
    rescannedAt: timestamp('rescanned_at'),
    /** When the run reached a terminal state. */
    endedAt: timestamp('ended_at'),
    stateChangedAt: timestamp('state_changed_at').notNull(),
  },
  (t) => [
    uniqueIndex('fix_runs_correlation_unique').on(t.correlationId),
    uniqueIndex('fix_runs_github_run_unique').on(t.repoId, t.githubRunId),
    index('fix_runs_repo_kind_idx').on(t.repoId, t.kind, t.id),
    index('fix_runs_state_idx').on(t.state),
    index('fix_runs_plan_idx').on(t.fixPlanId),
  ],
)

/** Free-form key/value settings (scan interval, notification targets, ...). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: updatedAt(),
})

export type SourceRow = typeof sources.$inferSelect
export type RepoRow = typeof repos.$inferSelect
export type NewRepoRow = typeof repos.$inferInsert
export type DeploymentRow = typeof deployments.$inferSelect
export type NewDeploymentRow = typeof deployments.$inferInsert
export type DeploymentRepoOverrideRow = typeof deploymentRepoOverrides.$inferSelect
export type AdvisoryRow = typeof advisories.$inferSelect
export type NewAdvisoryRow = typeof advisories.$inferInsert
export type FindingRow = typeof findings.$inferSelect
export type NewFindingRow = typeof findings.$inferInsert
export type FindingEventRow = typeof findingEvents.$inferSelect
export type NewFindingEventRow = typeof findingEvents.$inferInsert
export type ScanRunRow = typeof scanRuns.$inferSelect
export type SettingRow = typeof settings.$inferSelect
export type FixPlanRow = typeof fixPlans.$inferSelect
export type FixRunRow = typeof fixRuns.$inferSelect
export type NewFixRunRow = typeof fixRuns.$inferInsert
