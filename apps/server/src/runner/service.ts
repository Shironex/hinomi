import {
  DEFAULT_CALLER_WORKFLOW,
  LOCAL_RUNNER_WARNING,
  MAJORS_AGENT_SECRET,
  currentTime,
  isMajorStep,
  type FixDispatchEncoding,
  type FixResultV1,
  type FixRunPreviousPr,
  type FixRunnerKind,
  type RunnerKindsStatus,
  type RunnerCaller,
  type RunnerPermissions,
  type RunnerStatus,
  type UpdateRunnerSettingsRequest,
} from '@hinomi/shared'
import type { FixRunRow, RepoRow } from '../db/schema.js'
import type { Repositories } from '../repository/index.js'
import { fetchRunnerRepoMeta, type RunnerRepoMeta } from '../sources/github/index.js'
import { readCaller, unknownCaller, type LatestFixWorkflow } from './caller.js'
import { GithubActionsRunner, callerWorkflowOf } from './github-actions.js'
import { openRunnerGithub, type RunnerGithubFor } from './github.js'
import { releaseLatestSource, type LatestFixWorkflowSource } from './latest.js'
import { probeRunnerPermissions } from './permissions.js'
import { publishFixPr, type PublishFixPrOutcome } from './publisher.js'
import { openSetupPr, setupPrCapability, type SetupPrResult } from './setup-pr.js'
import type { LocalRunnerAvailability } from './local-runner.js'
import type { FixRunDispatchOutcome, FixRunner } from './runner.js'
import { WebhookRunner, type WebhookDelivery } from './webhook-runner.js'

// What the API calls: runner settings and status per repo, and dispatching the latest plan.
// The checks shared by every runner (on, a plan, decision 10) live here; the runner itself only
// creates the run and hands the plan over.

/** The runner status with the latest run as a row; the API serializes it. */
export type RunnerStatusView = Omit<RunnerStatus, 'latestRun'> & { latestRun: FixRunRow | null }

/** A run's closed unmerged PR, for the reopen question. */
export function previousPrOf(run: FixRunRow): FixRunPreviousPr | null {
  if (run.prNumber === null || run.prUrl === null) return null
  return {
    runId: run.id,
    pr: { number: run.prNumber, url: run.prUrl },
    closedAt: run.closedAt?.toISOString() ?? null,
  }
}

/** Why a dispatch was not made, as an HTTP answer. */
export interface DispatchRefused {
  kind: 'refused'
  status: 404 | 409 | 503
  code: 'not_found' | 'conflict' | 'unavailable'
  message: string
}

export type DispatchFixRunResult =
  | {
      kind: 'created'
      run: FixRunRow
      encoding: FixDispatchEncoding
      omittedStepIds: string[]
      /** The majors run dispatched beside `run`; null when none was (see dispatch). */
      majorsRun: FixRunRow | null
    }
  /** Decision 10: the last fix PR was closed unmerged; the UI asks before dispatching again. */
  | { kind: 'reopen_required'; previous: FixRunPreviousPr }
  | DispatchRefused

export interface FixRunServiceOptions {
  repositories: Repositories
  /** Fetch for GitHub calls. Replaced in tests. */
  fetch?: typeof fetch
  now?: () => Date
  /** A fixed release SHA callers should pin, for tests. Wins over `latestSource`. */
  latest?: LatestFixWorkflow | null
  /** Where the release SHA comes from. Defaults to the latest Hinomi release on GitHub. */
  latestSource?: LatestFixWorkflowSource
  /** Replaces the GitHub Actions runner in tests. */
  runner?: FixRunner
  /**
   * Posts plans for repos of the webhook kind (signing and the address guard live in the
   * webhook folder). Without it those repos cannot dispatch.
   */
  webhookDelivery?: WebhookDelivery
  /** The local runner, built in index.ts from the HINOMI_LOCAL_RUNNER settings. */
  localRunner?: FixRunner & { availability(): LocalRunnerAvailability }
  /** Replaces the runners of the other kinds in tests. */
  runners?: Partial<Record<Exclude<FixRunnerKind, 'github_actions'>, FixRunner>>
  /**
   * Public address of this Hinomi (the notification setting), read per publish. Fix PRs of
   * private repos link back to it; without it they carry no link.
   */
  publicBaseUrl?: () => string | null
}

export type FixRunService = ReturnType<typeof createFixRunService>

function refused(
  status: DispatchRefused['status'],
  code: DispatchRefused['code'],
  message: string,
): DispatchRefused {
  return { kind: 'refused', status, code, message }
}

/** The answer to a settings change the server refused. */
export type RunnerSettingsUpdate =
  | { ok: true; repo: RepoRow }
  | { ok: false; status: 404 | 409; code: 'not_found' | 'conflict'; message: string }

const LOCAL_UNAVAILABLE = 'The local runner is not available on this Hinomi.'
const LOCAL_NOT_WIRED =
  "Set HINOMI_LOCAL_RUNNER=1 in Hinomi's environment to allow the local runner."

function refusedDispatch(outcome: Exclude<FixRunDispatchOutcome, { created: true }>) {
  if (outcome.code === 'unavailable') return refused(503, 'unavailable', outcome.message)
  return refused(409, 'conflict', outcome.message)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const NO_PERMISSIONS = (message: string): RunnerPermissions => ({
  auth: null,
  ok: false,
  canOpenSetupPr: false,
  items: [],
  message,
})

/** Usable caller states: the file calls Hinomi (pin advice aside) and declares every input. */
function callerUsable(caller: RunnerCaller): boolean {
  const calls = ['unpinned', 'pinned', 'current', 'outdated'].includes(caller.state)
  return calls && caller.missingInputs.length === 0
}

/** Whether the repo can dispatch with its runner kind, and the line that says what is next. */
function readiness(
  repo: RepoRow,
  meta: RunnerRepoMeta | null,
  permissions: RunnerPermissions,
  caller: RunnerCaller,
  kinds: RunnerKindsStatus,
): { ready: boolean; message: string } {
  if (repo.runnerKind === 'github_actions') {
    const ready = repo.runnerEnabled && meta !== null && permissions.ok && callerUsable(caller)
    return { ready, message: statusMessage(repo, meta, permissions, caller) }
  }
  // Without the repo the permissions carry the reason it could not be read.
  if (!meta) return { ready: false, message: permissions.message }
  if (repo.runnerKind === 'local') {
    const local = kinds.local
    if (!local?.available) return { ready: false, message: local?.message ?? LOCAL_UNAVAILABLE }
    if (!repo.runnerEnabled) {
      return {
        ready: false,
        message: 'The local runner is on. Turn the runner on to dispatch fix plans.',
      }
    }
    return { ready: true, message: 'Ready to dispatch to the local runner.' }
  }
  if (!kinds.webhook.configured) return { ready: false, message: kinds.webhook.message }
  if (!repo.runnerEnabled) {
    return {
      ready: false,
      message: 'The webhook runner is set up. Turn the runner on to dispatch fix plans.',
    }
  }
  return { ready: true, message: 'Ready to dispatch to the webhook runner.' }
}

function statusMessage(
  repo: RepoRow,
  meta: RunnerRepoMeta | null,
  permissions: RunnerPermissions,
  caller: RunnerCaller,
): string {
  // Without the repo the permissions carry the reason it could not be read.
  if (!meta || !permissions.ok) return permissions.message
  if (!callerUsable(caller)) return caller.message
  if (!repo.runnerEnabled) return 'The runner is set up. Turn it on to dispatch fix plans.'
  if (repo.runnerMajorsAgent !== 'off' && caller.passesAgentSecret === false) {
    return `Ready to dispatch. The majors agent is on, but ${caller.path} passes no ${MAJORS_AGENT_SECRET} secret, so majors runs will fail.`
  }
  return 'Ready to dispatch.'
}

export function createFixRunService(options: FixRunServiceOptions) {
  const { repositories } = options
  const now = options.now ?? currentTime
  const fixed = options.latest
  const source =
    fixed === undefined
      ? (options.latestSource ??
        releaseLatestSource({ ...(options.fetch && { fetch: options.fetch }) }))
      : null
  const resolveLatest = (): Promise<LatestFixWorkflow | null> =>
    source ? source.get() : Promise.resolve(fixed ?? null)
  const github: RunnerGithubFor = (repoId) =>
    openRunnerGithub(repositories, repoId, { ...(options.fetch && { fetch: options.fetch }) })
  const webhookDelivery = options.webhookDelivery
  const runners: Record<FixRunnerKind, FixRunner | null> = {
    github_actions: options.runner ?? new GithubActionsRunner({ repositories, github, now }),
    webhook:
      options.runners?.webhook ??
      (webhookDelivery
        ? new WebhookRunner({ repositories, github, now, delivery: webhookDelivery })
        : null),
    local: options.runners?.local ?? options.localRunner ?? null,
  }

  function localStatus(): { available: boolean; message: string; warning: string } {
    const status = options.localRunner
      ? options.localRunner.availability()
      : options.runners?.local
        ? { available: true, message: 'The local runner is on.' }
        : { available: false, message: LOCAL_NOT_WIRED }
    return { ...status, warning: LOCAL_RUNNER_WARNING }
  }

  function kindsStatus(): RunnerKindsStatus {
    const problem = webhookDelivery
      ? webhookDelivery.problem()
      : 'The webhook runner is not wired into this server.'
    return {
      webhook: {
        configured: runners.webhook !== null && problem === null,
        message: problem ?? 'The webhook runner is set up.',
      },
      local: localStatus(),
    }
  }

  async function inspect(
    repo: RepoRow,
    workflow: string,
  ): Promise<{
    meta: RunnerRepoMeta | null
    permissions: RunnerPermissions
    caller: RunnerCaller
  }> {
    const latest = await resolveLatest()
    const unread = (message: string) => ({
      meta: null,
      permissions: NO_PERMISSIONS(message),
      caller: unknownCaller(workflow, message, latest, repo.runnerMajorsAgent),
    })
    const gh = github(repo.id)
    if (!gh.ok) return unread(gh.message)
    let meta: RunnerRepoMeta
    try {
      meta = await fetchRunnerRepoMeta(gh.source.client, repo.owner, repo.name)
    } catch (error) {
      return unread(
        `GitHub could not be asked about ${repo.owner}/${repo.name}: ${errorText(error)}`,
      )
    }
    const [permissions, caller] = await Promise.all([
      probeRunnerPermissions(gh.source, {
        owner: meta.owner,
        name: meta.name,
        workflow,
        visibility: meta.visibility,
      }).catch((error: unknown) =>
        NO_PERMISSIONS(`The runner permissions could not be checked: ${errorText(error)}`),
      ),
      readCaller(gh.source.client, {
        owner: meta.owner,
        name: meta.name,
        workflow,
        ref: meta.defaultBranch,
        latest,
        majorsAgent: repo.runnerMajorsAgent,
      }),
    ])
    return { meta, permissions, caller }
  }

  async function status(repo: RepoRow): Promise<RunnerStatusView> {
    const workflow = callerWorkflowOf(repo)
    const latestRun = repositories.fixRuns.latest(repo.id, 'fix')
    const closed = repositories.fixRuns.closedUnmergedPrevious(repo.id, 'fix')
    const { meta, permissions, caller } = await inspect(repo, workflow)
    const kinds = kindsStatus()
    const { ready, message } = readiness(repo, meta, permissions, caller, kinds)
    return {
      repoId: repo.id,
      settings: {
        enabled: repo.runnerEnabled,
        workflow,
        majorsAgent: repo.runnerMajorsAgent,
        kind: repo.runnerKind,
      },
      defaultWorkflow: DEFAULT_CALLER_WORKFLOW,
      ready,
      github: meta && {
        fullName: meta.fullName,
        defaultBranch: meta.defaultBranch,
        visibility: meta.visibility,
        checksMode: meta.visibility === 'public' ? 'full' : 'install',
      },
      permissions,
      setupPr: setupPrCapability(permissions, meta),
      caller,
      latestRun: latestRun ?? null,
      closedUnmerged: closed ? previousPrOf(closed) : null,
      checkedAt: now().toISOString(),
      message,
      runners: kinds,
    }
  }

  return {
    /** Live status of the repo's runner: settings, permissions, caller pin. Never throws on GitHub errors. */
    status,

    /**
     * Opens the PR that adds the caller workflow to the repo, or moves its pin to the latest
     * release; reuses the branch and open PR of an earlier call. See openSetupPr.
     */
    async setupPr(repoId: number): Promise<SetupPrResult> {
      const repo = repositories.repos.get(repoId)
      if (!repo)
        return { kind: 'refused', status: 404, code: 'not_found', message: 'Repo not found' }
      return openSetupPr({ repo, github: github(repo.id), latest: await resolveLatest() })
    },

    /**
     * Saves the settings. The local kind is refused unless this host allows it; the webhook
     * kind may be chosen before the webhook runner is set up (the status says what is missing).
     */
    updateSettings(repoId: number, patch: UpdateRunnerSettingsRequest): RunnerSettingsUpdate {
      if (!repositories.repos.get(repoId)) {
        return { ok: false, status: 404, code: 'not_found', message: 'Repo not found' }
      }
      if (patch.kind === 'local') {
        const local = localStatus()
        if (!local.available)
          return { ok: false, status: 409, code: 'conflict', message: local.message }
      }
      const repo = repositories.repos.setRunner(repoId, patch)
      if (!repo) return { ok: false, status: 404, code: 'not_found', message: 'Repo not found' }
      return { ok: true, repo }
    },

    /**
     * Dispatches the repo's latest plan. Refuses when the runner is off, there is no plan, or
     * the last fix (or majors) PR was closed unmerged and `confirmReopen` is not set.
     *
     * With the majors agent on and major upgrades in the plan, a second run of kind `majors`
     * is dispatched right after the fix run: its own workflow run (queued behind the fix run by
     * the workflow's concurrency group), branch and draft PR. A plan with only major upgrades
     * gets the majors run alone, returned as `run`. A majors dispatch the runner refuses
     * before creating a run is left out (`majorsRun: null`); one it refused after is a failed
     * run with the reason.
     */
    async dispatch(
      repoId: number,
      request: { confirmReopen?: boolean } = {},
    ): Promise<DispatchFixRunResult> {
      const repo = repositories.repos.get(repoId)
      if (!repo) return refused(404, 'not_found', 'Repo not found')
      if (!repo.runnerEnabled) {
        return refused(409, 'conflict', 'The fix runner is off for this repo. Turn it on first.')
      }
      const plan = repositories.fixPlans.forRepo(repo.id)
      if (!plan) return refused(404, 'not_found', 'Fix plan not found')
      const majors =
        repo.runnerMajorsAgent !== 'off' && plan.plan.steps.some((step) => isMajorStep(step))
      const kinds = majors ? (['fix', 'majors'] as const) : (['fix'] as const)
      for (const kind of kinds) {
        const closed = repositories.fixRuns.closedUnmergedPrevious(repo.id, kind)
        const previous = closed ? previousPrOf(closed) : null
        if (previous && request.confirmReopen !== true) {
          return { kind: 'reopen_required', previous }
        }
      }
      const runner = runners[repo.runnerKind]
      if (!runner) {
        const message =
          repo.runnerKind === 'webhook' ? kindsStatus().webhook.message : localStatus().message
        return refused(409, 'conflict', message)
      }
      const outcome = await runner.dispatch({ repo, plan, kind: 'fix' })
      const majorsOnly = majors && !outcome.created && outcome.code === 'nothing_to_send'
      if (!outcome.created && !majorsOnly) return refusedDispatch(outcome)
      const majorsOutcome = majors ? await runner.dispatch({ repo, plan, kind: 'majors' }) : null
      if (outcome.created) {
        return {
          kind: 'created',
          run: outcome.run,
          encoding: outcome.encoding,
          omittedStepIds: outcome.omittedStepIds,
          majorsRun: majorsOutcome?.created ? majorsOutcome.run : null,
        }
      }
      if (!majorsOutcome?.created) return refusedDispatch(majorsOutcome ?? outcome)
      return {
        kind: 'created',
        run: majorsOutcome.run,
        encoding: majorsOutcome.encoding,
        omittedStepIds: majorsOutcome.omittedStepIds,
        majorsRun: null,
      }
    },

    /**
     * Opens or updates the fix PR once the run's workflow pushed its branch (mode A), from the
     * decoded result artifact and the head SHA of the pushed branch. See publishFixPr.
     */
    publishFixPr(
      run: FixRunRow,
      result: FixResultV1,
      headSha: string,
    ): Promise<PublishFixPrOutcome> {
      return publishFixPr(
        {
          repositories,
          github,
          now,
          ...(options.publicBaseUrl && { publicBaseUrl: options.publicBaseUrl }),
        },
        run,
        result,
        headSha,
      )
    },
  }
}
