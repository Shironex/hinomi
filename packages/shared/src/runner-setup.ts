import { z } from 'zod'
import { apiErrorSchema } from './api.js'
import { fixRunKindSchema, fixRunSchema, fixRunnerKindSchema } from './fix-runs.js'
import { fixChecksModeSchema } from './runner.js'
import { FIX_DISPATCH_ENCODINGS } from './runner-payload.js'

// Setting up the GitHub Actions runner in a repo: the caller workflow each repo adds, the per
// repo runner settings, the runner status (permissions and caller pin) and the fix run API.

/** File name of the caller workflow under .github/workflows, unless the repo sets another. */
export const DEFAULT_CALLER_WORKFLOW = 'hinomi-fix.yml'
export const CALLER_WORKFLOW_DIR = '.github/workflows'

/** The reusable workflow every caller pins by commit SHA (decision 4 of the runner design). */
export const FIX_WORKFLOW = 'Shironex/hinomi/.github/workflows/fix.yml'

/**
 * The reusable workflow commit of the latest Hinomi release, which callers should pin. Null
 * until a release pins one; callers are then reported as pinned without an outdated check.
 */
export const LATEST_FIX_WORKFLOW: { sha: string; version: string } | null = null

/**
 * The workflow_dispatch inputs Hinomi sends. The caller workflow declares exactly these and
 * hands them to the reusable workflow: `run_id` (the fix run's correlation id, also in the
 * run name), `plan` (the encoded FixDispatchV1) and `encoding` (`json` or `gzip-base64`).
 */
export const FIX_DISPATCH_INPUTS = ['run_id', 'plan', 'encoding'] as const
export type FixDispatchInputName = (typeof FIX_DISPATCH_INPUTS)[number]

/**
 * The run name the caller workflow gives each run (`run-name: hinomi fix <run_id>`), which the
 * tracker matches when GitHub answered the dispatch without the run id.
 */
export const FIX_RUN_NAME_PREFIX = 'hinomi fix '

/** The run name of the fix run with this correlation id. */
export function fixRunName(correlationId: string): string {
  return `${FIX_RUN_NAME_PREFIX}${correlationId}`
}

/** A workflow file name: no folders, `.yml` or `.yaml`. */
export const callerWorkflowSchema = z
  .string()
  .min(5)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/, 'Must be a workflow file name ending in .yml')

const SHA_PLACEHOLDER = '<40 char sha>'

/**
 * The optional majors agent per repo: `off` (the default) or the coding agent preset whose
 * draft PR adapts the code to major upgrades (decision 7 of the runner design).
 */
export const RUNNER_MAJORS_AGENTS = ['off', 'claude-code'] as const
export const runnerMajorsAgentSchema = z.enum(RUNNER_MAJORS_AGENTS)
export type RunnerMajorsAgent = z.infer<typeof runnerMajorsAgentSchema>

/** The repo secret the caller hands to the reusable workflow for the Claude Code preset. */
export const MAJORS_AGENT_SECRET = 'ANTHROPIC_API_KEY'

/** The caller's secrets block: commented out while the majors agent is off. */
function secretsBlock(majorsAgent: RunnerMajorsAgent): string[] {
  const lines = ['secrets:', `  ${MAJORS_AGENT_SECRET}: \${{ secrets.${MAJORS_AGENT_SECRET} }}`]
  if (majorsAgent !== 'off') {
    return [
      '    # The majors agent is on in Hinomi; it reads this secret (docs/github.md).',
    ].concat(lines.map((line) => `    ${line}`))
  }
  return [
    '    # To let the optional majors agent run (off unless turned on in Hinomi), add the repo',
    '    # secret and uncomment these lines (docs/github.md):',
    ...lines.map((line) => `    # ${line}`),
  ]
}

/**
 * The caller workflow to paste into `.github/workflows/<file>` on the default branch, pinned to
 * `sha` (a placeholder when no release SHA is known yet). With the majors agent on, it hands the
 * agent's secret to the reusable workflow; off, that block is there but commented out.
 */
export function renderCallerWorkflow(
  options: {
    file?: string
    sha?: string | null
    version?: string | null
    majorsAgent?: RunnerMajorsAgent
  } = {},
): string {
  const file = options.file ?? DEFAULT_CALLER_WORKFLOW
  const sha = options.sha ?? SHA_PLACEHOLDER
  const comment = options.version ? ` # ${options.version}` : ''
  return [
    `# ${CALLER_WORKFLOW_DIR}/${file}`,
    'name: Hinomi fix',
    `run-name: ${fixRunName('${{ inputs.run_id }}')}`,
    '',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      run_id:',
    '        description: Hinomi run id',
    '        type: string',
    '        required: true',
    '      plan:',
    '        description: Fix plan from Hinomi (JSON, or gzip plus base64)',
    '        type: string',
    '        required: true',
    '      encoding:',
    '        type: choice',
    '        options: [json, gzip-base64]',
    '        default: json',
    '',
    'permissions: {}',
    '',
    'jobs:',
    '  fix:',
    `    uses: ${FIX_WORKFLOW}@${sha}${comment}`,
    '    permissions:',
    '      contents: write',
    '    with:',
    '      run_id: ${{ inputs.run_id }}',
    '      plan: ${{ inputs.plan }}',
    '      encoding: ${{ inputs.encoding }}',
    ...secretsBlock(options.majorsAgent ?? 'off'),
    '',
  ].join('\n')
}

const isoDate = z.iso.datetime({ offset: true })
const id = z.number().int().positive()

// ---------------------------------------------------------------------------
// Runner settings and status: GET and PATCH /api/repos/:id/runner

/** Per repo runner settings. The runner is off until turned on. */
export const runnerSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The caller workflow file under .github/workflows. */
  workflow: callerWorkflowSchema,
  /**
   * The optional majors agent. The server always sends it; absent (an older server) means off.
   */
  majorsAgent: runnerMajorsAgentSchema.optional(),
  /**
   * Where the plan runs: `github_actions` (default), `webhook` or `local`. The server always
   * sends it; absent (an older server) means GitHub Actions.
   */
  kind: fixRunnerKindSchema.optional(),
})
export type RunnerSettings = z.infer<typeof runnerSettingsSchema>

/** PATCH body. `workflow: null` goes back to the default file name. */
export const updateRunnerSettingsRequestSchema = z.strictObject({
  enabled: z.boolean().optional(),
  workflow: callerWorkflowSchema.nullable().optional(),
  majorsAgent: runnerMajorsAgentSchema.optional(),
  kind: fixRunnerKindSchema.optional(),
})
export type UpdateRunnerSettingsRequest = z.infer<typeof updateRunnerSettingsRequestSchema>

/** How Hinomi signs in to GitHub, as far as the runner cares. */
export const RUNNER_AUTHS = ['github_app', 'fine_grained_token', 'classic_token'] as const
export const runnerAuthSchema = z.enum(RUNNER_AUTHS)
export type RunnerAuth = z.infer<typeof runnerAuthSchema>

/**
 * `granted` was seen, `missing` was refused, `unverified` cannot be read without a write (a
 * fine grained token's write access shows only when it is used).
 */
export const runnerPermissionStatusSchema = z.enum(['granted', 'missing', 'unverified'])
export type RunnerPermissionStatus = z.infer<typeof runnerPermissionStatusSchema>

export const runnerPermissionSchema = z.object({
  /** The GitHub permission or scope: `actions`, `pull_requests`, `repo`, `workflow`. */
  name: z.string(),
  /** As GitHub's settings page shows it, with the level: `Actions: write`. */
  label: z.string(),
  /** What the runner uses it for. */
  purpose: z.string(),
  /** False for permissions only an optional feature needs (the setup PR, check polling). */
  required: z.boolean(),
  status: runnerPermissionStatusSchema,
})
export type RunnerPermission = z.infer<typeof runnerPermissionSchema>

export const runnerPermissionsSchema = z.object({
  /** Null when no GitHub source is connected or the probe failed. */
  auth: runnerAuthSchema.nullable(),
  /** No required permission is missing (unverified ones count as fine). */
  ok: z.boolean(),
  /** The credential can write workflow files, so Hinomi could open the setup PR. */
  canOpenSetupPr: z.boolean(),
  items: z.array(runnerPermissionSchema),
  message: z.string(),
})
export type RunnerPermissions = z.infer<typeof runnerPermissionsSchema>

/**
 * What the caller workflow on the default branch looks like:
 * - `missing`: no such file.
 * - `invalid`: not readable as YAML.
 * - `not_hinomi`: the file does not call the Hinomi reusable workflow.
 * - `unpinned`: it calls it by a tag or branch instead of a commit SHA.
 * - `pinned`: by a commit SHA, with no release SHA known to compare against.
 * - `current` and `outdated`: by a commit SHA, equal to or other than the latest release's.
 * - `unknown`: it could not be read (no GitHub source, no Contents permission, an error).
 */
export const RUNNER_CALLER_STATES = [
  'missing',
  'invalid',
  'not_hinomi',
  'unpinned',
  'pinned',
  'current',
  'outdated',
  'unknown',
] as const
export const runnerCallerStateSchema = z.enum(RUNNER_CALLER_STATES)
export type RunnerCallerState = z.infer<typeof runnerCallerStateSchema>

export const runnerCallerSchema = z.object({
  state: runnerCallerStateSchema,
  /** `.github/workflows/<file>`. */
  path: z.string(),
  /** The ref after `@` in the `uses:` line, when there is one. */
  ref: z.string().nullable(),
  /** The file exists on the default branch (any content). False when missing or unreadable. */
  present: z.boolean(),
  /** The commit SHA the file pins the Hinomi workflow to; null when unpinned or absent. */
  pinnedSha: z.string().nullable(),
  /** Pinned to a SHA other than `latestSha`: the setup PR then opens an "update the pin" PR. */
  outdated: z.boolean(),
  /** The release SHA callers should pin, null until one is known. */
  latestSha: z.string().nullable(),
  /** workflow_dispatch inputs Hinomi sends that the file does not declare. */
  missingInputs: z.array(z.string()),
  message: z.string(),
  /**
   * The file hands MAJORS_AGENT_SECRET to the reusable workflow (`secrets:` naming it, or
   * `secrets: inherit`). Absent when the file could not be read.
   */
  passesAgentSecret: z.boolean().optional(),
  /** The caller workflow to copy, pinned to the latest release SHA (or a placeholder). */
  template: z.string(),
})
export type RunnerCaller = z.infer<typeof runnerCallerSchema>

/** The repo's last fix PR, closed without merging. */
export const fixRunPreviousPrSchema = z.object({
  runId: id,
  pr: z.object({ number: id, url: z.string() }),
  closedAt: isoDate.nullable(),
})
export type FixRunPreviousPr = z.infer<typeof fixRunPreviousPrSchema>

/**
 * Whether the setup PR button can work. `reason` always says why, including when it is
 * available but cannot be verified in advance (a fine grained token's Workflows write).
 */
export const runnerSetupPrSchema = z.object({
  available: z.boolean(),
  reason: z.string(),
})
export type RunnerSetupPr = z.infer<typeof runnerSetupPrSchema>

/**
 * The warning the UI shows next to the local runner kind. The local runner runs the repo's own
 * package manager configuration on the Hinomi host (docs/runners.md, residual risks).
 */
export const LOCAL_RUNNER_WARNING =
  "The local runner applies fix plans on this Hinomi host. The repo's package manager config and hooks run as the Hinomi user, next to the database and the encrypted tokens, and the push token sits in the runner's environment while it runs. Use it only in a dedicated container with no other mounts, never on a workstation."

/** Whether the runners other than GitHub Actions can take a dispatch, for every repo. */
export const runnerKindsStatusSchema = z.object({
  webhook: z.object({
    /** A URL and a readable secret are set (see /api/settings/webhook-runner). */
    configured: z.boolean(),
    message: z.string(),
  }),
  /** Absent from a server before the local runner. */
  local: z
    .object({
      /** HINOMI_LOCAL_RUNNER=1 is set and the host can run it (git, the bundled action). */
      available: z.boolean(),
      /** Why it is not available, or how it runs when it is. */
      message: z.string(),
      /** LOCAL_RUNNER_WARNING, to show next to the kind switch whether or not it is available. */
      warning: z.string(),
    })
    .optional(),
})
export type RunnerKindsStatus = z.infer<typeof runnerKindsStatusSchema>

export const runnerStatusSchema = z.object({
  repoId: id,
  settings: runnerSettingsSchema,
  defaultWorkflow: z.string(),
  /** The runner is on, the credential may dispatch and the caller workflow calls Hinomi. */
  ready: z.boolean(),
  /** The repo as GitHub reports it now. Null when it could not be read. */
  github: z
    .object({
      fullName: z.string(),
      defaultBranch: z.string(),
      visibility: z.enum(['public', 'private']),
      /** What a dispatch sends: full checks on public repos, install only on private ones. */
      checksMode: fixChecksModeSchema,
    })
    .nullable(),
  permissions: runnerPermissionsSchema,
  /** Whether Hinomi can open the setup PR (or the update the pin PR) for this repo. */
  setupPr: runnerSetupPrSchema,
  caller: runnerCallerSchema,
  /** The repo's newest fix run. */
  latestRun: fixRunSchema.nullable(),
  /** Set when the last fix PR was closed unmerged: a dispatch must confirm reopening. */
  closedUnmerged: fixRunPreviousPrSchema.nullable(),
  checkedAt: isoDate,
  /** One line on what to do next, or that the runner is ready. */
  message: z.string(),
  /** The other runner kinds. Absent from an older server. */
  runners: runnerKindsStatusSchema.optional(),
})
export type RunnerStatus = z.infer<typeof runnerStatusSchema>

// ---------------------------------------------------------------------------
// Setup PR: POST /api/repos/:id/runner/setup-pr

/**
 * - `created`: a new PR adds (or re-pins) the caller workflow.
 * - `updated`: the PR from an earlier call is still open; its branch and text are current now.
 * - `already_set_up`: the default branch already has exactly this caller; nothing was opened.
 */
export const SETUP_PR_OUTCOMES = ['created', 'updated', 'already_set_up'] as const
export const setupPrOutcomeSchema = z.enum(SETUP_PR_OUTCOMES)
export type SetupPrOutcome = z.infer<typeof setupPrOutcomeSchema>

/** The setup PR branch Hinomi uses, so a second call finds the first one's work. */
export const SETUP_PR_BRANCH = 'hinomi/setup-fix-runner'

/** 200 (or 201 for a new PR). Errors: 404 repo, 409 no release SHA or no permission, 503 GitHub. */
export const setupPrResponseSchema = z.object({
  outcome: setupPrOutcomeSchema,
  /** Null only for `already_set_up`. */
  pr: z.object({ number: id, url: z.string() }).nullable(),
  /** The file written, `.github/workflows/<file>`. */
  path: z.string(),
  /** The release commit the caller pins, and its version. */
  sha: z.string(),
  version: z.string(),
})
export type SetupPrResponse = z.infer<typeof setupPrResponseSchema>

// ---------------------------------------------------------------------------
// Fix runs: POST and GET /api/repos/:id/fix-runs, GET /api/fix-runs/:id

/** POST body. `confirmReopen` is needed when the last fix PR was closed unmerged. */
export const dispatchFixRunRequestSchema = z.strictObject({
  confirmReopen: z.boolean().optional(),
})
export type DispatchFixRunRequest = z.infer<typeof dispatchFixRunRequestSchema>

/**
 * 201 once the run row exists. A dispatch GitHub refused is still a run, in state `failed`
 * with the reason in `stateReason`.
 */
export const dispatchFixRunResponseSchema = z.object({
  run: fixRunSchema,
  /** How the plan input was encoded. */
  encoding: z.enum(FIX_DISPATCH_ENCODINGS),
  /** Plan step ids the payload budget left out; they wait for the next run. */
  omittedStepIds: z.array(z.string()),
  /**
   * The majors run dispatched beside `run` (majors agent on and the plan has major upgrades).
   * Null when none was. When the plan has no safe step, `run` itself is the majors run.
   */
  majorsRun: fixRunSchema.nullable().optional(),
})
export type DispatchFixRunResponse = z.infer<typeof dispatchFixRunResponseSchema>

/** 409 when the last fix PR was closed unmerged and the request did not confirm reopening. */
export const fixRunReopenRequiredSchema = apiErrorSchema.extend({
  previous: fixRunPreviousPrSchema,
})
export type FixRunReopenRequired = z.infer<typeof fixRunReopenRequiredSchema>

export const fixRunsQuerySchema = z.strictObject({
  kind: fixRunKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const fixRunsResponseSchema = z.object({
  /** Newest first. */
  items: z.array(fixRunSchema),
})
export type FixRunsResponse = z.infer<typeof fixRunsResponseSchema>
