import {
  DEFAULT_CALLER_WORKFLOW,
  LATEST_FIX_WORKFLOW,
  currentTime,
  type FixDispatchEncoding,
  type FixResultV1,
  type FixRunPreviousPr,
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
import { openRunnerGithub, type RunnerGithub } from './github.js'
import { probeRunnerPermissions } from './permissions.js'
import { publishFixPr, type PublishFixPrOutcome } from './publisher.js'
import type { FixRunner } from './runner.js'

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
  | { kind: 'created'; run: FixRunRow; encoding: FixDispatchEncoding; omittedStepIds: string[] }
  /** Decision 10: the last fix PR was closed unmerged; the UI asks before dispatching again. */
  | { kind: 'reopen_required'; previous: FixRunPreviousPr }
  | DispatchRefused

export interface FixRunServiceOptions {
  repositories: Repositories
  /** Fetch for GitHub calls. Replaced in tests. */
  fetch?: typeof fetch
  now?: () => Date
  /** The release SHA callers should pin. Defaults to LATEST_FIX_WORKFLOW. */
  latest?: LatestFixWorkflow | null
  /** Replaces the GitHub Actions runner in tests. */
  runner?: FixRunner
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
  return 'Ready to dispatch.'
}

export function createFixRunService(options: FixRunServiceOptions) {
  const { repositories } = options
  const now = options.now ?? currentTime
  const latest = options.latest === undefined ? LATEST_FIX_WORKFLOW : options.latest
  const github = (): RunnerGithub =>
    openRunnerGithub(repositories, { ...(options.fetch && { fetch: options.fetch }) })
  const runner: FixRunner = options.runner ?? new GithubActionsRunner({ repositories, github, now })

  async function inspect(
    repo: RepoRow,
    workflow: string,
  ): Promise<{
    meta: RunnerRepoMeta | null
    permissions: RunnerPermissions
    caller: RunnerCaller
  }> {
    const unread = (message: string) => ({
      meta: null,
      permissions: NO_PERMISSIONS(message),
      caller: unknownCaller(workflow, message, latest),
    })
    const gh = github()
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
      }),
    ])
    return { meta, permissions, caller }
  }

  async function status(repo: RepoRow): Promise<RunnerStatusView> {
    const workflow = callerWorkflowOf(repo)
    const latestRun = repositories.fixRuns.latest(repo.id, 'fix')
    const closed = repositories.fixRuns.closedUnmergedPrevious(repo.id, 'fix')
    const { meta, permissions, caller } = await inspect(repo, workflow)
    return {
      repoId: repo.id,
      settings: { enabled: repo.runnerEnabled, workflow },
      defaultWorkflow: DEFAULT_CALLER_WORKFLOW,
      ready: repo.runnerEnabled && meta !== null && permissions.ok && callerUsable(caller),
      github: meta && {
        fullName: meta.fullName,
        defaultBranch: meta.defaultBranch,
        visibility: meta.visibility,
        checksMode: meta.visibility === 'public' ? 'full' : 'install',
      },
      permissions,
      caller,
      latestRun: latestRun ?? null,
      closedUnmerged: closed ? previousPrOf(closed) : null,
      checkedAt: now().toISOString(),
      message: statusMessage(repo, meta, permissions, caller),
    }
  }

  return {
    /** Live status of the repo's runner: settings, permissions, caller pin. Never throws on GitHub errors. */
    status,

    /** Saves the settings. Undefined when the repo does not exist. */
    updateSettings(repoId: number, patch: UpdateRunnerSettingsRequest): RepoRow | undefined {
      return repositories.repos.setRunner(repoId, patch)
    },

    /**
     * Dispatches the repo's latest plan. Refuses when the runner is off, there is no plan, or
     * the last fix PR was closed unmerged and `confirmReopen` is not set.
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
      const closed = repositories.fixRuns.closedUnmergedPrevious(repo.id, 'fix')
      const previous = closed ? previousPrOf(closed) : null
      if (previous && request.confirmReopen !== true) {
        return { kind: 'reopen_required', previous }
      }
      const outcome = await runner.dispatch({ repo, plan })
      if (outcome.created) {
        return {
          kind: 'created',
          run: outcome.run,
          encoding: outcome.encoding,
          omittedStepIds: outcome.omittedStepIds,
        }
      }
      if (outcome.code === 'unavailable') return refused(503, 'unavailable', outcome.message)
      return refused(409, 'conflict', outcome.message)
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
