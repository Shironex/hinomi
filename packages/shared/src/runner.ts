import { z } from 'zod'
import {
  FINDING_TIERS,
  FIX_PLAN_VERSION,
  RELEASE_AGE_GATE_DAYS,
  bumpLevelSchema,
  dependencyRelationshipSchema,
  findingTierSchema,
  fixPlanRiskReasonSchema,
  fixPlanSchema,
  packageManagerSchema,
  releaseAgeSchema,
  type FindingTier,
  type FixPlan,
  type FixPlanStep,
} from './api.js'
import { currentTime } from './clock.js'

// The contract between Hinomi and the GitHub Actions fix runner (docs/design/fix-runner.md).
// Hinomi projects a FixPlan into a FixDispatchV1, sends it as the `plan` input of a
// workflow_dispatch, and reads back the FixResultV1 the `apply` job uploads. The runner
// validates both with these schemas, so a hand written or tampered dispatch is held to the
// same rules as one Hinomi built.

/** Value of `schema` in a dispatch. A runner refuses any other value. */
export const FIX_DISPATCH_SCHEMA = 'hinomi.fix-dispatch/1'
/** Value of `schema` in a result. Hinomi refuses any other value. */
export const FIX_RESULT_SCHEMA = 'hinomi.fix-result/1'

/** Most steps (and most risky entries) one dispatch carries. */
export const FIX_DISPATCH_MAX_STEPS = 200
/** Lines of a check's output the result keeps, counted from the end. */
export const CHECK_OUTPUT_MAX_LINES = 60
/** Characters of a check's output the result keeps, counted from the end. */
export const CHECK_OUTPUT_MAX_CHARS = 4_000
/** Most major upgrades one majors dispatch hands to the agent, so the prompt stays readable. */
export const FIX_MAJORS_MAX_STEPS = 50

/**
 * Coding agent presets the majors job knows. `claude-code` runs Claude Code headless; `stub`
 * makes a fixed edit without any model and is accepted only in a dry run (the self test).
 */
export const FIX_AGENT_PRESETS = ['claude-code', 'stub'] as const
export const fixAgentPresetSchema = z.enum(FIX_AGENT_PRESETS)
export type FixAgentPreset = z.infer<typeof fixAgentPresetSchema>

const isoDate = z.iso.datetime({ offset: true })
const id = z.number().int().positive()
const count = z.number().int().nonnegative()

// Names and versions are checked against their grammar, so nothing that reaches a manifest
// edit or a command line can carry a range, a URL, a path or shell syntax.
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/
const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// Risky entries are only read by the optional agent job and the PR body, and may carry
// versions that are not semver (risk reason unknown_version), so they get a looser check
// that still excludes whitespace, quotes and shell syntax.
const PLAIN_TOKEN = /^[A-Za-z0-9@/._~+:-]+$/
const ADVISORY_KEY = /^[A-Za-z0-9._:-]+$/
const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const RUN_ID = /^[A-Za-z0-9._-]+$/
const SHA = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/

const exactVersion = z.string().max(64).regex(EXACT_VERSION)
const looseVersion = z.string().max(64).regex(PLAIN_TOKEN)
const packageName = z
  .string()
  .max(214)
  .refine((name) => NPM_NAME.test(name) || CRATE_NAME.test(name), 'not a package name')
const loosePackageName = z.string().max(214).regex(PLAIN_TOKEN)
const advisoryKey = z.string().max(64).regex(ADVISORY_KEY)
const ecosystem = z.string().max(32).regex(PLAIN_TOKEN)

/** True for a repo relative path that stays inside the repo and away from `.github`. */
export function isSafeRepoPath(path: string): boolean {
  if (path === '.') return true
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || /[\\\0\s]/.test(path)) return false
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false
  return segments[0] !== '.github'
}

const repoPath = z.string().refine(isSafeRepoPath, 'not a safe repo relative path')
const manifestPath = repoPath.refine(
  (path) => path === 'package.json' || path.endsWith('/package.json'),
  'not a package.json path',
)
const branchName = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((name) => !name.includes('..') && !name.startsWith('/') && !name.endsWith('/'))

/**
 * How the runner applies a step. The FixPlan `apply` union without `manual`, with every value
 * checked. The rules a runner follows for each type:
 * - manifest_bump: replace only the version in each manifest and keep the range prefix (`^`, `~`
 *   or an exact pin). Specifiers that are not a version (`workspace:`, `catalog:`, `npm:`,
 *   git, file) are left alone and reported as skipped with reason `manual_specifier`. For Cargo
 *   `manifests` is empty and the step's `workspaces` names the crates: the runner finds each
 *   crate's Cargo.toml with `cargo metadata`, Hinomi never fetches manifests for this.
 * - override: `field` `pnpm.overrides` means a pnpm override, and the runner picks the file:
 *   `overrides` in the project's `pnpm-workspace.yaml` when that file exists, else
 *   `pnpm.overrides` in `manifest`. An override that already exists for the package is updated
 *   where it is, never added twice. `overrides` (npm, bun) and `resolutions` (yarn) go in
 *   `manifest`.
 * - lockfile_update: `cargo update -p <packageName>@<from> --precise <to>` for every `from`.
 */
function applySchema(version: z.ZodString, name: z.ZodType<string>) {
  return z.discriminatedUnion('type', [
    z.object({
      type: z.literal('manifest_bump'),
      manifests: z.array(manifestPath).max(100),
      packageName: name,
      version,
    }),
    z.object({
      type: z.literal('override'),
      manifest: manifestPath,
      field: z.enum(['pnpm.overrides', 'overrides', 'resolutions']),
      key: z.string().max(300).regex(PLAIN_TOKEN),
      value: version,
    }),
    z.object({
      type: z.literal('lockfile_update'),
      tool: z.literal('cargo'),
      packageName: name,
      from: z.array(version).min(1).max(20),
      to: version,
    }),
  ])
}

export const fixDispatchApplySchema = applySchema(exactVersion, packageName)
export type FixDispatchApply = z.infer<typeof fixDispatchApplySchema>

const NPM_FAMILY = new Set(['npm', 'pnpm', 'yarn', 'bun'])

const dispatchStepFields = z.object({
  /** The FixPlan step id, echoed in the result. */
  id: z.string().min(1).max(512),
  /** The FixPlan order; the runner applies steps in this order. */
  order: z.number().int().positive(),
  /** Most urgent tier among the step's findings, in FINDING_TIERS order. */
  tier: findingTierSchema,
  ecosystem,
  packageName,
  relationship: dependencyRelationshipSchema,
  lockfile: repoPath,
  packageManager: packageManagerSchema.exclude(['unknown']),
  workspaces: z.array(repoPath).max(200),
  from: z.array(exactVersion).min(1).max(20),
  to: exactVersion,
  level: bumpLevelSchema,
  apply: fixDispatchApplySchema,
  /** Advisory keys, for logs and the agent prompt. The size budget drops these first. */
  advisories: z.array(advisoryKey).max(100),
  releasedAt: isoDate.nullable(),
  /** What Hinomi knew. The runner checks the registry itself before it applies the step. */
  releaseAge: releaseAgeSchema,
})

function stepProblems(step: z.infer<typeof dispatchStepFields>): string[] {
  const { apply } = step
  const problems: string[] = []
  const npmFamily = NPM_FAMILY.has(step.packageManager)
  if (apply.type !== 'override' && apply.packageName !== step.packageName) {
    problems.push('apply.packageName differs from packageName')
  }
  if (npmFamily && !NPM_NAME.test(step.packageName)) problems.push('not an npm package name')
  if (!npmFamily && !CRATE_NAME.test(step.packageName)) problems.push('not a crate name')
  if (apply.type === 'manifest_bump') {
    if (npmFamily && apply.manifests.length === 0) problems.push('manifest_bump lists no manifest')
    if (!npmFamily && apply.manifests.length > 0) problems.push('cargo bumps name crates instead')
  }
  if (apply.type === 'override') {
    if (!npmFamily) problems.push('override needs an npm family package manager')
    const { key } = apply
    if (key !== step.packageName && !key.startsWith(`${step.packageName}@`)) {
      problems.push('override key is not for this package')
    }
  }
  if (apply.type === 'lockfile_update' && step.packageManager !== 'cargo') {
    problems.push('lockfile_update is cargo only')
  }
  return problems
}

/** One safe step of the plan, as the runner applies it. */
export const fixDispatchStepSchema = dispatchStepFields.superRefine((step, ctx) => {
  for (const problem of stepProblems(step)) ctx.addIssue({ code: 'custom', message: problem })
})
export type FixDispatchStep = z.infer<typeof fixDispatchStepSchema>

/** A risky step: never in the fix PR, read by the optional majors job and listed in the body. */
export const fixDispatchRiskySchema = z.object({
  id: z.string().min(1).max(512),
  order: z.number().int().positive(),
  tier: findingTierSchema,
  ecosystem,
  packageName: loosePackageName,
  packageManager: packageManagerSchema,
  lockfile: repoPath.nullable(),
  workspaces: z.array(repoPath).max(200),
  from: z.array(looseVersion).max(20),
  to: looseVersion,
  level: bumpLevelSchema,
  riskReasons: z.array(fixPlanRiskReasonSchema),
  note: z.string().max(500).nullable(),
  /** Null when the plan says `manual`: a person (or the agent) works out the change. */
  apply: applySchema(looseVersion, loosePackageName).nullable(),
  advisories: z.array(advisoryKey).max(100),
})
export type FixDispatchRisky = z.infer<typeof fixDispatchRiskySchema>

/**
 * full: install, then the repo's lint, typecheck, test and build. install: install only, the
 * fix PR's own CI runs the checks. Hinomi sends full for public repos, install for private ones.
 */
export const fixChecksModeSchema = z.enum(['full', 'install'])
export type FixChecksMode = z.infer<typeof fixChecksModeSchema>

/** What Hinomi sends in the workflow_dispatch input `plan`, after decoding. */
export const fixDispatchV1Schema = z.object({
  schema: z.literal(FIX_DISPATCH_SCHEMA),
  /** Hinomi's fix run id, also in the workflow's run-name so the run can be matched. */
  runId: z.string().min(1).max(64).regex(RUN_ID),
  dispatchedAt: isoDate,
  plan: z.object({
    version: z.literal(FIX_PLAN_VERSION),
    scanRunId: id,
    createdAt: isoDate,
  }),
  repo: z.object({
    id,
    /** Must equal `github.repository`; the runner refuses the dispatch otherwise. */
    fullName: z.string().max(200).regex(REPO_FULL_NAME),
    /** The branch the fix branch starts from, the repo's default branch. */
    baseBranch: branchName,
  }),
  /** Safe steps only, in `order`. Every one is applied in the single fix PR. */
  steps: z.array(fixDispatchStepSchema).max(FIX_DISPATCH_MAX_STEPS),
  /** Risky steps for the majors job. Empty unless `options.agent` is on. */
  risky: z.array(fixDispatchRiskySchema).max(FIX_DISPATCH_MAX_STEPS),
  /** What the size budget left out of this payload, so the runner can say so. */
  omitted: z.object({ steps: count, risky: count, advisories: z.boolean() }),
  options: z.object({
    checks: fixChecksModeSchema,
    /** Run the optional majors job for `risky` (only when the repo has the agent secret). */
    agent: z.boolean(),
    /** The coding agent the majors job runs. Absent means `claude-code`. */
    agentPreset: fixAgentPresetSchema.optional(),
    /** The PR may link back to Hinomi: true for private repos only. */
    linksAllowed: z.boolean(),
    /**
     * Hinomi's release age floor in days. The runner reads the repo's own gate too and uses
     * the stricter one; it never lowers a gate or adds an exclusion.
     */
    releaseAgeDays: count,
  }),
})
export type FixDispatchV1 = z.infer<typeof fixDispatchV1Schema>

// ---------------------------------------------------------------------------
// Result

/**
 * Why a step was skipped or failed. already_fixed: the lockfile already resolves `to`.
 * no_longer_vulnerable: `from` moved and the new version is not affected. too_new: `to` is
 * inside the release age gate. manual_specifier: the manifest uses a specifier the runner does
 * not edit. not_in_lockfile: the package is not in the lockfile, so the step would add a
 * dependency. install_failed: the install broke with this step and passed without it.
 * edit_failed: the manifest could not be edited.
 */
export const fixStepReasonSchema = z.enum([
  'already_fixed',
  'no_longer_vulnerable',
  'too_new',
  'manual_specifier',
  'not_in_lockfile',
  'install_failed',
  'edit_failed',
])
export type FixStepReason = z.infer<typeof fixStepReasonSchema>

export const fixResultStepSchema = z.object({
  id: z.string().min(1).max(512),
  status: z.enum(['applied', 'skipped', 'failed']),
  /** Null for applied steps. */
  reason: fixStepReasonSchema.nullable(),
  /** One line, e.g. the first line of the install error. */
  detail: z.string().max(500).nullable(),
  /** Manifests the step edited. */
  files: z.array(repoPath).max(100),
})
export type FixResultStep = z.infer<typeof fixResultStepSchema>

/** The registry check of one step's target version against the release age gate. */
export const fixReleaseAgeCheckSchema = z.object({
  stepId: z.string().min(1).max(512),
  packageName: loosePackageName,
  version: looseVersion,
  /** Publish time from the registry, null when the registry did not say. */
  publishedAt: isoDate.nullable(),
  /** The gate applied: the stricter of the repo's gate and Hinomi's floor. */
  gateDays: count,
  /** Where the gate came from, e.g. `pnpm-workspace.yaml`, `.npmrc` or `hinomi`. */
  gateSource: z.string().max(100),
  status: releaseAgeSchema,
  /** When a too_new version clears the gate. */
  eligibleAt: isoDate.nullable(),
})
export type FixReleaseAgeCheck = z.infer<typeof fixReleaseAgeCheckSchema>

const output = {
  /** The end of the output, at most CHECK_OUTPUT_MAX_LINES lines and CHECK_OUTPUT_MAX_CHARS. */
  output: z.string().max(CHECK_OUTPUT_MAX_CHARS).nullable(),
  /** The output was longer and was cut. */
  truncated: z.boolean(),
}

export const fixCheckResultSchema = z.object({
  /** `lint`, `typecheck`, `test`, `build`, `cargo check`, ... */
  name: z.string().min(1).max(100),
  command: z.string().max(500),
  status: z.enum(['passed', 'failed', 'skipped', 'timeout']),
  durationMs: count,
  ...output,
})
export type FixCheckResult = z.infer<typeof fixCheckResultSchema>

/**
 * How the coding agent of a majors run ended. changed: it left a patch. no_changes: it changed
 * nothing the patch may carry. failed: it exited with an error (or could not start). timeout:
 * the runner stopped it. refused: its changes broke a limit of the majors patch (too many files
 * or bytes), so nothing is published.
 */
export const FIX_AGENT_OUTCOMES = ['changed', 'no_changes', 'failed', 'timeout', 'refused'] as const
export const fixAgentOutcomeSchema = z.enum(FIX_AGENT_OUTCOMES)
export type FixAgentOutcome = z.infer<typeof fixAgentOutcomeSchema>

/** What the majors job reports about its coding agent, in the result's `agent` field. */
export const fixAgentReportSchema = z.object({
  preset: fixAgentPresetSchema,
  outcome: fixAgentOutcomeSchema,
  /** One line on why it failed, timed out or was refused; null when it changed something. */
  detail: z.string().max(500).nullable(),
  /** The end of the agent's final message, scrubbed and cut like check output. */
  summary: z.string().max(CHECK_OUTPUT_MAX_CHARS).nullable(),
  durationMs: count,
  /** Turns and estimated cost when the agent reports them. */
  turns: count.nullable(),
  costUsd: z.number().nonnegative().nullable(),
  /** Changed paths the majors allowlist kept out of the patch (workflows, hooks, config). */
  refusedPaths: z.array(z.string().max(512)).max(200),
})
export type FixAgentReport = z.infer<typeof fixAgentReportSchema>

/** What the `apply` job writes to `.hinomi/hinomi-result.json`. */
export const fixResultV1Schema = z.object({
  schema: z.literal(FIX_RESULT_SCHEMA),
  runId: z.string().min(1).max(64).regex(RUN_ID),
  planScanRunId: id,
  repo: z.string().max(200).regex(REPO_FULL_NAME),
  /** The commit of the base branch the steps were applied to. */
  baseSha: z.string().regex(SHA),
  packageManager: packageManagerSchema,
  packageManagerVersion: z.string().max(64).nullable(),
  checksMode: fixChecksModeSchema,
  /** One entry per dispatched step. */
  steps: z.array(fixResultStepSchema).max(FIX_DISPATCH_MAX_STEPS),
  releaseAge: z.array(fixReleaseAgeCheckSchema).max(FIX_DISPATCH_MAX_STEPS),
  install: z.object({
    status: z.enum(['ok', 'failed', 'skipped']),
    durationMs: count,
    ...output,
  }),
  /** Checks in the order they ran. Empty in install mode. */
  checks: z.array(fixCheckResultSchema).max(20),
  /** The final patch, null when nothing changed. */
  patch: z
    .object({
      sha256: z.string().regex(SHA256),
      files: z.array(repoPath).max(500),
      insertions: count,
      deletions: count,
    })
    .nullable(),
  /**
   * Set by the majors job only: the coding agent's report. Its `steps` are the risky steps it
   * was handed, `applied` when the patch changes the step's lockfile.
   */
  agent: fixAgentReportSchema.optional(),
  finishedAt: isoDate,
})
export type FixResultV1 = z.infer<typeof fixResultV1Schema>

// ---------------------------------------------------------------------------
// Parsing with version checks

export type FixPayloadErrorCode = 'unsupported_version' | 'malformed' | 'too_large' | 'mismatch'

/** A plan, dispatch or result the runner contract cannot accept. */
export class FixPayloadError extends Error {
  override readonly name = 'FixPayloadError'
  readonly code: FixPayloadErrorCode

  constructor(code: FixPayloadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const first = parsed.error.issues[0]
  const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : ''
  throw new FixPayloadError('malformed', `Invalid ${what}${where}: ${first?.message ?? ''}`, {
    cause: parsed.error,
  })
}

/** Parses a fix plan, refusing any `version` other than FIX_PLAN_VERSION. */
export function parseFixPlan(value: unknown): FixPlan {
  const version = field(value, 'version')
  if (version !== FIX_PLAN_VERSION) {
    throw new FixPayloadError(
      'unsupported_version',
      `Unsupported fix plan version ${JSON.stringify(version)}, expected ${FIX_PLAN_VERSION}`,
    )
  }
  return parseWith(fixPlanSchema, value, 'fix plan')
}

/** Parses a decoded dispatch, refusing an unknown `schema` or plan version. */
export function parseFixDispatch(value: unknown): FixDispatchV1 {
  const schema = field(value, 'schema')
  if (schema !== FIX_DISPATCH_SCHEMA) {
    throw new FixPayloadError(
      'unsupported_version',
      `Unsupported fix dispatch ${JSON.stringify(schema)}, expected ${FIX_DISPATCH_SCHEMA}`,
    )
  }
  const planVersion = field(field(value, 'plan'), 'version')
  if (planVersion !== FIX_PLAN_VERSION) {
    throw new FixPayloadError(
      'unsupported_version',
      `Unsupported fix plan version ${JSON.stringify(planVersion)}, expected ${FIX_PLAN_VERSION}`,
    )
  }
  return parseWith(fixDispatchV1Schema, value, 'fix dispatch')
}

/** Parses a result file, refusing an unknown `schema`. */
export function parseFixResult(value: unknown): FixResultV1 {
  const schema = field(value, 'schema')
  if (schema !== FIX_RESULT_SCHEMA) {
    throw new FixPayloadError(
      'unsupported_version',
      `Unsupported fix result ${JSON.stringify(schema)}, expected ${FIX_RESULT_SCHEMA}`,
    )
  }
  return parseWith(fixResultV1Schema, value, 'fix result')
}

// ---------------------------------------------------------------------------
// Projection

export interface FixDispatchOptions {
  /** Hinomi's fix run id. */
  runId: string
  /** The repo's default branch. */
  baseBranch: string
  /** Public repos get full checks and no links back to Hinomi; private repos the opposite. */
  visibility: 'public' | 'private'
  /** Send risky steps for the majors job. Default false. Ignored for `kind: 'majors'`. */
  agent?: boolean
  /**
   * `fix` (the default) sends the safe steps. `majors` sends no safe step and only the major
   * upgrades (isMajorStep, at most FIX_MAJORS_MAX_STEPS) for the agent job, with the agent on.
   */
  kind?: 'fix' | 'majors'
  /** The agent preset a majors dispatch asks for. Default `claude-code`. */
  agentPreset?: FixAgentPreset
  /** Overrides the checks mode the visibility picks. */
  checks?: FixChecksMode
  now?: Date
}

/** Most urgent tier with findings in a tier count record, `not_deployed` when none. */
export function mostUrgentTier(byTier: Partial<Record<FindingTier, number>>): FindingTier {
  return FINDING_TIERS.find((tier) => (byTier[tier] ?? 0) > 0) ?? 'not_deployed'
}

function toDispatchStep(step: FixPlanStep): FixDispatchStep | null {
  if (step.risk !== 'safe' || step.apply.type === 'manual' || step.lockfile === null) return null
  const candidate = {
    id: step.id,
    order: step.order,
    tier: mostUrgentTier(step.byTier),
    ecosystem: step.ecosystem,
    packageName: step.packageName,
    relationship: step.relationship,
    lockfile: step.lockfile,
    packageManager: step.packageManager,
    workspaces: step.workspaces,
    from: step.from,
    to: step.to,
    level: step.level,
    apply: step.apply,
    advisories: step.advisories,
    releasedAt: step.releasedAt,
    releaseAge: step.releaseAge,
  }
  const parsed = fixDispatchStepSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function toDispatchRisky(step: FixPlanStep): FixDispatchRisky | null {
  const parsed = fixDispatchRiskySchema.safeParse({
    id: step.id,
    order: step.order,
    tier: mostUrgentTier(step.byTier),
    ecosystem: step.ecosystem,
    packageName: step.packageName,
    packageManager: step.packageManager,
    lockfile: step.lockfile,
    workspaces: step.workspaces,
    from: step.from,
    to: step.to,
    level: step.level,
    riskReasons: step.riskReasons,
    note: step.note,
    apply: step.apply.type === 'manual' ? null : step.apply,
    advisories: step.advisories,
  })
  return parsed.success ? parsed.data : null
}

/**
 * True for a plan step the majors job takes: risky because it crosses a semver major, with a
 * lockfile and a package manager the runner knows, so the agent has a project to work in.
 */
export function isMajorStep(step: FixPlanStep): boolean {
  return (
    step.risk === 'risky' &&
    (step.level === 'major' || step.riskReasons.includes('semver_major')) &&
    step.lockfile !== null &&
    step.packageManager !== 'unknown'
  )
}

function majorsRisky(sorted: FixPlanStep[]): FixDispatchRisky[] {
  return sorted
    .filter(isMajorStep)
    .map(toDispatchRisky)
    .filter((s): s is FixDispatchRisky => s !== null)
}

/**
 * Projects a plan into what the runner needs. Safe steps that the runner can apply go in
 * `steps`; a safe step it cannot (manual, no lockfile, or a value that fails the strict
 * checks) is left out and shows in the PR body as not sent. Risky steps go in `risky` only
 * when the agent is on; the PR body lists them either way, from the plan. With `kind: 'majors'`
 * it builds the agent's own dispatch instead: no safe step, the major upgrades in `risky`.
 */
export function toFixDispatch(plan: FixPlan, options: FixDispatchOptions): FixDispatchV1 {
  const checked = parseFixPlan(plan)
  const majors = options.kind === 'majors'
  const agent = majors || (options.agent ?? false)
  const sorted = [...checked.steps].sort((a, b) => a.order - b.order)
  const steps = majors
    ? []
    : sorted.map(toDispatchStep).filter((s): s is FixDispatchStep => s !== null)
  const maxRisky = majors ? FIX_MAJORS_MAX_STEPS : FIX_DISPATCH_MAX_STEPS
  const risky = majors
    ? majorsRisky(sorted)
    : agent
      ? sorted
          .filter((s) => s.risk === 'risky')
          .map(toDispatchRisky)
          .filter((s): s is FixDispatchRisky => s !== null)
      : []
  const dispatch: FixDispatchV1 = {
    schema: FIX_DISPATCH_SCHEMA,
    runId: options.runId,
    dispatchedAt: (options.now ?? currentTime()).toISOString(),
    plan: {
      version: FIX_PLAN_VERSION,
      scanRunId: checked.scanRunId,
      createdAt: checked.createdAt,
    },
    repo: { id: checked.repo.id, fullName: checked.repo.fullName, baseBranch: options.baseBranch },
    steps: steps.slice(0, FIX_DISPATCH_MAX_STEPS),
    risky: risky.slice(0, maxRisky),
    omitted: {
      steps: Math.max(0, steps.length - FIX_DISPATCH_MAX_STEPS),
      risky: Math.max(0, risky.length - maxRisky),
      advisories: false,
    },
    options: {
      checks: options.checks ?? (options.visibility === 'public' ? 'full' : 'install'),
      agent,
      ...(majors && { agentPreset: options.agentPreset ?? 'claude-code' }),
      linksAllowed: options.visibility === 'private',
      releaseAgeDays: RELEASE_AGE_GATE_DAYS,
    },
  }
  return parseWith(fixDispatchV1Schema, dispatch, 'fix dispatch')
}

// ---------------------------------------------------------------------------
// Check output

// Token shapes scrubbed from check output on top of the runner's own masking.
const TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})/g

/**
 * The tail of a check's output as the result keeps it: the last CHECK_OUTPUT_MAX_LINES lines,
 * at most CHECK_OUTPUT_MAX_CHARS characters, with token shaped strings replaced by `***`.
 */
export function truncateCheckOutput(text: string): { output: string; truncated: boolean } {
  const scrubbed = text.replace(TOKEN_PATTERN, '***').replace(/\s+$/, '')
  const lines = scrubbed.split('\n')
  let tail = lines.slice(-CHECK_OUTPUT_MAX_LINES).join('\n')
  if (tail.length > CHECK_OUTPUT_MAX_CHARS) tail = tail.slice(-CHECK_OUTPUT_MAX_CHARS)
  return { output: tail, truncated: tail.length < scrubbed.length }
}
