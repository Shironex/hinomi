import {
  FIX_MAJORS_MAX_STEPS,
  MAJORS_BRANCH,
  isMajorStep,
  toFixDispatch,
  type FixAgentOutcome,
  type FixCheckResult,
  type FixPlan,
  type FixPlanStep,
  type FixResultV1,
  type FixRun,
  type FixRunAfterMerge,
  type FixRunnerKind,
  type FixRunDeployStatus,
  type FixRunDetail,
  type FixRunState,
  type FixRunVerification,
  type FixRunVerifyAfter,
  type FixRunWarningCode,
  type RunnerCallerState,
  type RunnerStatus,
} from '@hinomi/shared'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClockHour4,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconHourglassHigh,
  IconLoader2,
  IconPlayerSkipForward,
  IconRocket,
  IconShieldCheck,
  IconShieldX,
  IconUnlink,
  type Icon,
} from '@tabler/icons-react'
import type { StatusTone } from '@/components/findings/finding-state'

// Labels, tones and derived views of fix plans and fix runs, kept free of React so they are
// unit tested on their own.

export interface RunStateInfo {
  /** Short, for rows and badges: "Checks failing". */
  label: string
  tone: StatusTone
  icon: Icon
  /** Spins while the run is working on its own. */
  spin?: boolean
  /** One line on what happens next, or what a person should do. */
  next: string
}

export const RUN_STATE_INFO: Record<FixRunState, RunStateInfo> = {
  pending: {
    label: 'Dispatching',
    tone: 'run',
    icon: IconLoader2,
    spin: true,
    next: 'Hinomi is asking GitHub to start the caller workflow.',
  },
  dispatched: {
    label: 'Dispatched',
    tone: 'run',
    icon: IconHourglassHigh,
    next: 'GitHub accepted the dispatch. Waiting for the workflow run to start.',
  },
  queued: {
    label: 'Queued',
    tone: 'run',
    icon: IconHourglassHigh,
    next: 'The workflow run waits for a free GitHub runner.',
  },
  running: {
    label: 'Running',
    tone: 'run',
    icon: IconLoader2,
    spin: true,
    next: 'The runner applies the safe steps, installs and runs the checks.',
  },
  branch_pushed: {
    label: 'Branch pushed',
    tone: 'run',
    icon: IconGitPullRequest,
    next: 'Hinomi opens or updates the pull request from the pushed branch.',
  },
  pr_open: {
    label: 'PR open',
    tone: 'run',
    icon: IconGitPullRequest,
    next: 'Waiting for the repo to report checks on the pull request.',
  },
  checks_pending: {
    label: 'Checks running',
    tone: 'run',
    icon: IconLoader2,
    spin: true,
    next: 'Checks are running on the pull request.',
  },
  checks_passing: {
    label: 'Checks passing',
    tone: 'ok',
    icon: IconCircleCheck,
    next: 'Ready for review. Hinomi never merges: review and merge it on GitHub.',
  },
  checks_failing: {
    label: 'Checks failing',
    tone: 'bad',
    icon: IconCircleX,
    next: 'The pull request stays a draft with the failure output. A person needs to look.',
  },
  checks_none: {
    label: 'No checks',
    tone: 'wait',
    icon: IconCircleDashed,
    next: 'The repo runs no checks on pull requests. Review the change by hand before merging.',
  },
  merged: {
    label: 'Merged',
    tone: 'run',
    icon: IconGitMerge,
    next: 'Waiting for a deploy of the merge commit, then a rescan of the repo.',
  },
  deployed: {
    label: 'Deployed',
    tone: 'run',
    icon: IconRocket,
    next: 'The fix is deployed. A rescan of the repo checks the findings are gone.',
  },
  nothing_to_do: {
    label: 'Nothing to change',
    tone: 'neutral',
    icon: IconPlayerSkipForward,
    next: 'Every step was already applied, so no branch or pull request. A rescan confirms the findings are gone.',
  },
  verified: {
    label: 'Verified',
    tone: 'ok',
    icon: IconShieldCheck,
    next: 'A rescan confirmed the findings are gone.',
  },
  not_cleared: {
    label: 'Not cleared',
    tone: 'bad',
    icon: IconShieldX,
    next: 'The rescan still finds some of the findings. Check the lockfile on the default branch and the deploys.',
  },
  failed: {
    label: 'Failed',
    tone: 'bad',
    icon: IconCircleX,
    next: 'Fix what the reason says, then run the plan again.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    icon: IconCircleX,
    next: 'The workflow run was cancelled. A re-run on GitHub brings it back.',
  },
  closed_unmerged: {
    label: 'Closed unmerged',
    tone: 'wait',
    icon: IconGitPullRequestClosed,
    next: 'The pull request was closed without merging. Hinomi asks before it opens a fresh one.',
  },
  superseded: {
    label: 'Superseded',
    tone: 'neutral',
    icon: IconPlayerSkipForward,
    next: 'A newer run of the same repo took over before this one merged.',
  },
  lost: {
    label: 'Lost',
    tone: 'bad',
    icon: IconUnlink,
    next: 'Hinomi stopped following a workflow run that never finished. Look at it on GitHub.',
  },
}

// ---------------------------------------------------------------------------
// Runner kinds

export interface RunnerKindInfo {
  /** "GitHub Actions", for the selector and the run detail. */
  label: string
  /** What the stage that applies the plan is called in a run's timeline. */
  stage: string
  /** Where the plan runs, to finish "Runs the latest fix plan of repo ...". */
  where: string
}

export const RUNNER_KIND_INFO: Record<FixRunnerKind, RunnerKindInfo> = {
  github_actions: {
    label: 'GitHub Actions',
    stage: 'Workflow run',
    where: 'in its own GitHub Actions',
  },
  webhook: {
    label: 'Webhook runner',
    stage: 'Webhook runner',
    where: 'on the webhook runner',
  },
  local: { label: 'Local runner', stage: 'Local runner', where: 'on this Hinomi host' },
}

/** The repo's runner kind; absent from an older server means GitHub Actions. */
export const runnerKindOf = (status: Pick<RunnerStatus, 'settings'> | undefined): FixRunnerKind =>
  status?.settings.kind ?? 'github_actions'

/** Where the runner kinds are described, for the settings and the runner panel. */
export const RUNNERS_DOCS_URL = 'https://github.com/Shironex/hinomi/blob/main/docs/runners.md'

/** Why the majors agent does not run on the local runner (docs/runners.md). */
export const LOCAL_MAJORS_NOTE =
  'The majors agent does not run on the local runner: its preset installs packages as root and needs a sandbox a Hinomi host should not grant. Use GitHub Actions or the webhook runner for major upgrades.'

/** What a state means for a run on a runner other than GitHub Actions, where it differs. */
const EXTERNAL_NEXT: Record<'webhook' | 'local', Partial<Record<FixRunState, string>>> = {
  webhook: {
    pending: 'Hinomi is posting the plan to the webhook runner.',
    dispatched:
      'The webhook runner accepted the plan. Waiting for it to report back on the callback path.',
    queued: 'The webhook runner reported the run as queued.',
    running: 'The webhook runner applies the safe steps. Waiting for its result.',
    cancelled: 'The webhook runner reported the run as cancelled.',
    lost: 'The webhook runner sent no result within 2 hours of the dispatch, so Hinomi stopped waiting.',
  },
  local: {
    pending: 'Hinomi is starting the local runner on this host.',
    dispatched: 'The local runner is cloning the repo and applying the safe steps on this host.',
    queued: 'The local runner is starting.',
    running: 'The local runner applies the safe steps on this host.',
    cancelled: 'The local run was cancelled.',
    lost: 'The local run sent no result within 2 hours of the dispatch, so Hinomi stopped waiting.',
  },
}

/** Where the setup and behaviour of the optional majors agent is written down. */
export const MAJORS_DOCS_URL =
  'https://github.com/Shironex/hinomi/blob/main/docs/github.md#the-optional-majors-agent'

/** The branch the majors draft PR lives on. */
export const MAJORS_BRANCH_NAME = MAJORS_BRANCH

/** What each state means for a majors run, where it differs from a fix run. */
const MAJORS_NEXT: Partial<Record<FixRunState, string>> = {
  running:
    'The coding agent edits the code for the major upgrades, then the runner keeps the changes as a patch.',
  branch_pushed: 'Hinomi opens or updates the draft pull request from the pushed branch.',
  checks_passing:
    "The draft pull request's own CI passes. Review the agent's changes before you mark it ready: Hinomi never merges.",
  checks_failing:
    "The draft pull request's own CI fails. The agent's changes may need a person to finish them.",
  nothing_to_do: 'The agent left nothing to change.',
  failed: "Read the agent's reason, then run the plan again.",
  closed_unmerged:
    'The draft pull request was closed without merging. Hinomi asks before it opens a fresh one.',
}

/** Why no app deploys the fix: the rescan reads the default branch right after the merge. */
const NO_DEPLOY_DETAIL = 'No app deploys the fix, so the rescan reads the default branch'

/** What a merged run waits for, from the server's expectation. */
function mergedNext(afterMerge: FixRunAfterMerge): string {
  if (afterMerge.expects === 'rescan_after_merge') {
    return 'No app deploys the fix, so Hinomi rescans the repo right after the merge.'
  }
  const apps = afterMerge.apps === 1 ? 'the app' : `${afterMerge.apps} apps`
  return `Waiting for a deploy of the merge commit by ${apps}, then a rescan of the repo.`
}

/** One line on what happens next, for a fix run or a majors run. */
export function runNext(
  run: Pick<FixRun, 'state' | 'kind'> & { runner?: FixRunnerKind; afterMerge?: FixRunAfterMerge },
): string {
  if (run.state === 'merged' && run.afterMerge) return mergedNext(run.afterMerge)
  const external = run.runner && run.runner !== 'github_actions' ? run.runner : null
  return (
    (external ? EXTERNAL_NEXT[external][run.state] : undefined) ??
    (run.kind === 'majors' ? MAJORS_NEXT[run.state] : undefined) ??
    RUN_STATE_INFO[run.state].next
  )
}

export const AGENT_OUTCOME_INFO: Record<
  FixAgentOutcome,
  { label: string; tone: StatusTone; icon: Icon }
> = {
  changed: { label: 'Changed the code', tone: 'ok', icon: IconCircleCheck },
  no_changes: { label: 'Made no change', tone: 'neutral', icon: IconCircleDashed },
  failed: { label: 'Failed', tone: 'bad', icon: IconCircleX },
  timeout: { label: 'Timed out', tone: 'bad', icon: IconClockHour4 },
  refused: { label: 'Patch refused', tone: 'bad', icon: IconShieldX },
}

/** Estimated agent cost in USD, to the cent. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** States that need a person: listed first, so failed checks come before everything else. */
const ATTENTION: readonly FixRunState[] = [
  'checks_failing',
  'failed',
  'not_cleared',
  'lost',
  'closed_unmerged',
]

/** 0 needs a person, 1 is still going, 2 has ended quietly. Lower sorts first. */
export function runUrgency(state: FixRunState | undefined): number {
  if (state === undefined) return 2
  if (ATTENTION.includes(state)) return 0
  if (['verified', 'cancelled', 'superseded', 'nothing_to_do'].includes(state)) return 2
  return 1
}

/** The state with the pull request number once there is one, for rows and the timeline. */
export function runSummary(run: Pick<FixRun, 'state' | 'pr'>): string {
  const label = RUN_STATE_INFO[run.state].label
  return run.pr && run.state !== 'pr_open' ? `PR #${run.pr.number}, ${label.toLowerCase()}` : label
}

// ---------------------------------------------------------------------------
// Timeline

export type StepStatus = 'done' | 'now' | 'fail' | 'todo' | 'skip'

export interface TimelineStep {
  key: 'dispatch' | 'run' | 'pr' | 'checks' | 'merged' | 'deployed' | 'verified'
  title: string
  status: StepStatus
  detail: string
  /** When the step happened (done or failed), or started (now). */
  at: string | null
}

const STAGES: { key: TimelineStep['key']; title: string }[] = [
  { key: 'dispatch', title: 'Dispatched' },
  { key: 'run', title: RUNNER_KIND_INFO.github_actions.stage },
  { key: 'pr', title: 'Pull request' },
  { key: 'checks', title: 'Checks' },
  { key: 'merged', title: 'Merged by a person' },
  { key: 'deployed', title: 'Deployed' },
  { key: 'verified', title: 'Verified by a rescan' },
]

/** A run as the timeline reads it: the list row, or the detail with deployments and verification. */
export type TimelineRun = FixRun &
  Partial<Pick<FixRunDetail, 'deployments' | 'warnings' | 'verification' | 'afterMerge'>>

/**
 * True when no app ships the fix, so the rescan reads the default branch right after the merge:
 * known from the server's expectation as soon as the run merged, and from the verification after.
 */
const verifiesAfterMerge = (run: TimelineRun) =>
  run.verification?.after === 'merge' ||
  (run.state === 'merged' && run.afterMerge?.expects === 'rescan_after_merge')

const deployNotSeen = (run: TimelineRun) =>
  run.state === 'merged' && (run.warnings ?? []).some((w) => w.code === 'deploy_not_seen')

/** Index of the stage the run is at, and how that stage stands. */
function position(run: TimelineRun): { index: number; status: StepStatus } {
  const at = run.at
  switch (run.state) {
    case 'pending':
      return { index: 0, status: 'now' }
    case 'dispatched':
    case 'queued':
    case 'running':
      return { index: 1, status: 'now' }
    case 'branch_pushed':
      return { index: 2, status: 'now' }
    case 'pr_open':
    case 'checks_pending':
      return { index: 3, status: 'now' }
    case 'checks_failing':
      return { index: 3, status: 'fail' }
    case 'checks_passing':
    case 'checks_none':
      return { index: 4, status: 'now' }
    case 'merged':
      if (verifiesAfterMerge(run)) return { index: 6, status: 'now' }
      return { index: 5, status: deployNotSeen(run) ? 'fail' : 'now' }
    case 'deployed':
    case 'nothing_to_do':
      return { index: 6, status: 'now' }
    case 'verified':
      return { index: 6, status: 'done' }
    case 'not_cleared':
      return { index: 6, status: 'fail' }
    case 'closed_unmerged':
      return { index: 4, status: 'fail' }
    case 'failed':
    case 'cancelled':
    case 'lost':
    case 'superseded': {
      const status: StepStatus = run.state === 'superseded' ? 'skip' : 'fail'
      if (!at.dispatched && run.state === 'failed') return { index: 0, status }
      if (at.merged) return { index: 5, status }
      if (run.pr) return { index: 3, status }
      if (at.pushed || (at.completed && run.result?.patch)) return { index: 2, status }
      return { index: 1, status }
    }
  }
}

function stageTime(run: TimelineRun, key: TimelineStep['key'], status: StepStatus): string | null {
  const at = run.at
  switch (key) {
    case 'dispatch':
      return at.dispatched ?? at.created
    case 'run':
      return status === 'now' ? at.started : (at.completed ?? at.started ?? at.ended)
    case 'pr':
      return at.prOpened ?? at.pushed ?? (status === 'fail' ? at.ended : null)
    case 'checks':
      return at.checksUpdated ?? (status === 'fail' ? at.ended : null)
    case 'merged':
      return at.merged ?? at.closed ?? (status === 'fail' ? at.ended : null)
    case 'deployed':
      return at.deployed
    case 'verified':
      return at.rescanned ?? run.verification?.scan?.at ?? (status === 'fail' ? at.ended : null)
  }
}

function checksCount(result: FixResultV1 | null): string | null {
  if (!result || result.checks.length === 0) return null
  const passed = result.checks.filter((c) => c.status === 'passed').length
  return `${passed} of ${result.checks.length} runner checks passed`
}

function shippedBy(run: TimelineRun): string | null {
  const apps = (run.deployments ?? []).filter((d) => d.status !== 'other_branch')
  const shipped = apps.filter((d) => d.status === 'deployed')
  if (!shipped.length) return null
  if (apps.length === 1) return `${shipped[0]!.name} shipped it`
  return `${shipped.length} of ${apps.length} apps shipped it`
}

/** One line on where the verification rescan stands. */
export function verificationLine(v: FixRunVerification): string {
  switch (v.status) {
    case 'pending':
      return 'Waiting for a rescan of the repo'
    case 'retrying':
      return `The rescan failed ${v.attempts === 1 ? 'once' : `${v.attempts} times`}, trying again`
    case 'scheduled_scan':
      return 'Rescans kept failing, so the next scheduled scan verifies it'
    case 'done':
      return `${v.cleared.length} of ${v.targeted.length} finding${v.targeted.length === 1 ? '' : 's'} cleared`
  }
}

/** The workflow run stage of a majors run: the agent's turn, not the safe steps. */
function majorsRunDetail(run: TimelineRun, status: StepStatus): string {
  const agent = run.result?.agent
  if (status === 'now') {
    return run.state === 'running'
      ? 'The agent is editing the code for the major upgrades'
      : runNext(run)
  }
  if (agent) {
    const turns = agent.turns === null ? '' : `, ${agent.turns} turn${agent.turns === 1 ? '' : 's'}`
    const cost = agent.costUsd === null ? '' : `, ${formatCost(agent.costUsd)}`
    return `Agent: ${AGENT_OUTCOME_INFO[agent.outcome].label.toLowerCase()}${turns}${cost}`
  }
  return 'A coding agent edits the code for the major upgrades'
}

function stageDetail(run: TimelineRun, key: TimelineStep['key'], status: StepStatus): string {
  const failing = status === 'fail' || status === 'skip'
  switch (key) {
    case 'dispatch':
      if (run.runner === 'webhook') {
        if (failing) return run.stateReason ?? 'The webhook runner refused the plan.'
        return status === 'now'
          ? 'Posting the plan to the webhook runner'
          : 'The webhook runner accepted the plan'
      }
      if (run.runner === 'local') {
        if (failing) return run.stateReason ?? 'The local runner could not start.'
        return status === 'now' ? 'Starting the local runner' : 'The local runner started'
      }
      if (failing) return run.stateReason ?? 'GitHub refused the dispatch.'
      return status === 'now'
        ? 'Asking GitHub to start the caller workflow'
        : 'GitHub accepted the caller workflow dispatch'
    case 'run':
      if (failing) return run.stateReason ?? runNext(run)
      if (run.kind === 'majors') return majorsRunDetail(run, status)
      if (status === 'now') {
        return run.state === 'running' ? 'Applying the safe steps and running checks' : runNext(run)
      }
      if (status === 'done' && run.result) {
        const applied = run.result.steps.filter((s) => s.status === 'applied').length
        const total = run.result.steps.length
        return `${applied} of ${total} step${total === 1 ? '' : 's'} applied`
      }
      return 'Applies the safe steps, installs and runs the checks'
    case 'pr':
      if (run.state === 'nothing_to_do') return 'No changes needed, so no pull request'
      if (failing) return run.stateReason ?? 'The pull request could not be opened.'
      if (run.pr) return `#${run.pr.number}${run.pr.draft ? ', draft' : ''} on ${run.branch}`
      return status === 'now' ? `Opening it from ${run.branch}` : `Opened from ${run.branch}`
    case 'checks':
      if (run.state === 'nothing_to_do') return 'Nothing to check'
      if (run.state === 'checks_failing')
        return 'Failing. The pull request stays a draft with the failure output'
      if (failing) return run.stateReason ?? runNext(run)
      if (run.state === 'checks_none' || (status === 'done' && run.at.checksUpdated === null)) {
        return 'The repo reported no checks on the pull request'
      }
      if (status === 'done') return checksCount(run.result) ?? 'Passing on the pull request'
      if (status === 'now') return 'Running on the pull request'
      return 'The repo CI on the pull request'
    case 'merged':
      if (run.state === 'nothing_to_do') return 'Nothing to merge'
      if (run.state === 'closed_unmerged') return 'Closed without merging'
      if (failing) return run.stateReason ?? runNext(run)
      if (status === 'now') return 'Waiting for a person to review and merge on GitHub'
      if (status === 'done' && run.pr?.mergeSha)
        return `Merge commit ${run.pr.mergeSha.slice(0, 7)}`
      return 'Hinomi never merges'
    case 'deployed':
      if (run.state === 'nothing_to_do') return 'Nothing to deploy'
      if (verifiesAfterMerge(run)) return NO_DEPLOY_DETAIL
      if (status === 'fail') return 'No deploy of the merge commit within 3 days'
      if (status === 'now') return 'Waiting for a deploy of the merge commit'
      if (status === 'done') return shippedBy(run) ?? 'A deploy shipped the merge commit'
      return 'A deploy of the merge commit or a later one'
    case 'verified':
      if (run.verification && status !== 'todo') return verificationLine(run.verification)
      if (run.state === 'not_cleared') return run.stateReason ?? runNext(run)
      if (status === 'done') return 'The rescan no longer finds the findings'
      if (status === 'now') return 'A rescan of the repo compares the findings of the plan'
      return 'A rescan compares the findings of the plan'
  }
}

/** The seven stages of a fix run with how far it got, for the timeline in the run detail. */
export function runTimeline(run: TimelineRun): TimelineStep[] {
  const { index, status } = position(run)
  const skipToRescan = run.state === 'nothing_to_do'
  const skipDeploy = verifiesAfterMerge(run) && index >= 5
  return STAGES.map((stage, i) => {
    let s: StepStatus = i < index ? 'done' : i === index ? status : 'todo'
    if (skipToRescan && i >= 2 && i <= 5) s = 'skip'
    if (skipDeploy && i === 5) s = 'skip'
    return {
      key: stage.key,
      title: stage.key === 'run' ? RUNNER_KIND_INFO[run.runner].stage : stage.title,
      status: s,
      detail: stageDetail(run, stage.key, s),
      at: s === 'todo' || (skipDeploy && i === 5) ? null : stageTime(run, stage.key, s),
    }
  })
}

// ---------------------------------------------------------------------------
// Checks

const CHECK_ORDER: Record<FixCheckResult['status'], number> = {
  failed: 0,
  timeout: 1,
  passed: 2,
  skipped: 3,
}

/** Runner checks with failures and timeouts first, otherwise in the order they ran. */
export function orderedChecks(checks: readonly FixCheckResult[]): FixCheckResult[] {
  return checks
    .map((check, i) => ({ check, i }))
    .sort((a, b) => CHECK_ORDER[a.check.status] - CHECK_ORDER[b.check.status] || a.i - b.i)
    .map(({ check }) => check)
}

/** "1.2 s", "3 min 4 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

/** Package and target out of a step id (`apply:ecosystem:package:to:lockfile`). */
export function parseStepId(id: string): { packageName: string; to: string } | null {
  const parts = id.split(':')
  if (parts.length < 4 || !parts[2] || !parts[3]) return null
  return { packageName: parts[2], to: parts[3] }
}

export const STEP_REASON_LABEL: Record<string, string> = {
  already_fixed: 'Already fixed in the lockfile',
  no_longer_vulnerable: 'No longer vulnerable',
  too_new: 'Inside the release age gate',
  manual_specifier: 'Specifier the runner does not edit',
  not_in_lockfile: 'Not in the lockfile',
  install_failed: 'The install broke with this step',
  edit_failed: 'The manifest could not be edited',
}

// ---------------------------------------------------------------------------
// What a dispatch of the plan changes

export interface DiffLine {
  sign: '+' | '-' | ' '
  text: string
}

export interface DiffFile {
  path: string
  /** Lines to show; empty for a lockfile the install regenerates. */
  lines: DiffLine[]
  /** One line under the file name: "regenerated by pnpm install". */
  note: string | null
}

export interface PlanPreview {
  /** Safe steps the runner receives, in order. */
  sent: FixPlanStep[]
  /** Major upgrades the optional agent takes into its own draft PR (at most 50). */
  majors: FixPlanStep[]
  /** Safe steps the runner cannot apply (manual, no lockfile): listed in the PR as not sent. */
  notSent: FixPlanStep[]
  /** Risky steps: never in the fix PR, always listed in its body. */
  risky: FixPlanStep[]
  files: DiffFile[]
  /** Findings the sent steps clear. */
  findings: number
}

const RUN_ID_PREVIEW = 'preview'

/** The step ids a dispatch would carry, computed by the same projection the server uses. */
function sentIds(plan: FixPlan): Set<string> | null {
  try {
    const dispatch = toFixDispatch(plan, {
      runId: RUN_ID_PREVIEW,
      baseBranch: 'main',
      visibility: 'private',
    })
    return new Set(dispatch.steps.map((s) => s.id))
  } catch {
    return null
  }
}

function addLines(files: Map<string, DiffFile>, path: string, lines: DiffLine[]) {
  const file = files.get(path) ?? { path, lines: [], note: null }
  file.lines.push(...lines)
  files.set(path, file)
}

/**
 * What the fix PR of this plan will change, as a diff per file: manifest bumps, overrides and
 * Cargo lockfile updates, then the lockfiles the install regenerates. Range prefixes are kept
 * by the runner, so a manifest line shows the version only.
 */
export function previewPlan(plan: FixPlan): PlanPreview {
  const ids = sentIds(plan)
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order)
  const safe = ordered.filter((s) => s.risk === 'safe')
  const canSend = (s: FixPlanStep) =>
    ids ? ids.has(s.id) : s.apply.type !== 'manual' && s.lockfile !== null
  const sent = safe.filter(canSend)
  const notSent = safe.filter((s) => !canSend(s))
  const risky = ordered.filter((s) => s.risk === 'risky')

  const files = new Map<string, DiffFile>()
  const lockfiles = new Map<string, string>()
  for (const step of sent) {
    const from = step.from.length ? step.from.join(', ') : 'unknown'
    const apply = step.apply
    if (apply.type === 'manifest_bump') {
      const manifests = apply.manifests.length
        ? apply.manifests
        : step.workspaces.map((crate) => `${crate} (Cargo.toml)`)
      for (const manifest of manifests) {
        addLines(files, manifest, [
          { sign: '-', text: `"${apply.packageName}": "${from}"` },
          { sign: '+', text: `"${apply.packageName}": "${apply.version}"` },
        ])
      }
    } else if (apply.type === 'override') {
      addLines(files, apply.manifest, [
        { sign: ' ', text: `${apply.field}:` },
        { sign: '+', text: `  "${apply.key}": "${apply.value}"` },
      ])
    } else if (apply.type === 'lockfile_update') {
      addLines(files, step.lockfile ?? 'Cargo.lock', [
        { sign: '-', text: `${apply.packageName} ${apply.from.join(', ')}` },
        { sign: '+', text: `${apply.packageName} ${apply.to}` },
      ])
    }
    if (step.lockfile && apply.type !== 'lockfile_update') {
      lockfiles.set(step.lockfile, step.packageManager)
    }
  }
  for (const [lockfile, manager] of lockfiles) {
    if (files.has(lockfile)) continue
    files.set(lockfile, {
      path: lockfile,
      lines: [],
      note: `Regenerated by ${manager === 'unknown' ? 'the' : manager} install`,
    })
  }
  const findings = new Set(sent.flatMap((s) => s.findingIds)).size
  const majors = ordered.filter(isMajorStep).slice(0, FIX_MAJORS_MAX_STEPS)
  return { sent, majors, notSent, risky, files: [...files.values()], findings }
}

export const RISK_REASON_LABEL: Record<string, string> = {
  semver_major: 'Semver major',
  pins_other_versions: 'Moves other installed versions',
  unknown_version: 'Version is not semver',
  unknown_relationship: 'Direct or transitive unknown',
  unknown_package_manager: 'No lockfile Hinomi reads',
}

// ---------------------------------------------------------------------------
// Runner caller workflow

export const CALLER_STATE_INFO: Record<
  RunnerCallerState,
  { label: string; tone: StatusTone; icon: Icon }
> = {
  missing: { label: 'Not added yet', tone: 'wait', icon: IconCircleDashed },
  invalid: { label: 'Not valid YAML', tone: 'bad', icon: IconCircleX },
  not_hinomi: { label: 'Does not call Hinomi', tone: 'bad', icon: IconCircleX },
  unpinned: { label: 'Not pinned by SHA', tone: 'wait', icon: IconAlertTriangle },
  pinned: { label: 'Pinned', tone: 'ok', icon: IconCircleCheck },
  current: { label: 'Up to date', tone: 'ok', icon: IconCircleCheck },
  outdated: { label: 'Outdated pin', tone: 'wait', icon: IconClockHour4 },
  unknown: { label: 'Could not be read', tone: 'neutral', icon: IconCircleDashed },
}

// ---------------------------------------------------------------------------
// Fix runs page selection

/** `?sel=` of a repo's plan row on the fix runs page. Runs use their numeric id. */
export function planKey(repoId: number): string {
  return `plan-${repoId}`
}

// ---------------------------------------------------------------------------
// Deployments and verification

export const DEPLOY_STATUS_INFO: Record<
  FixRunDeployStatus,
  { label: string; tone: StatusTone; icon: Icon }
> = {
  waiting: { label: 'Waiting for a deploy', tone: 'wait', icon: IconHourglassHigh },
  deployed: { label: 'Shipped the fix', tone: 'ok', icon: IconRocket },
  other_branch: { label: 'Deploys another branch', tone: 'neutral', icon: IconCircleDashed },
}

export const WARNING_LABEL: Record<FixRunWarningCode, string> = {
  watch_paths_skip: 'Watch paths skip the fix',
  deploy_not_seen: 'No deploy seen',
}

export const VERIFY_AFTER_TEXT: Record<FixRunVerifyAfter, string> = {
  deploy: 'Rescans after every app shipped the fix, or the wait for the others ran out.',
  merge:
    'No app deploys the branch the fix merged into, so the rescan reads the lockfile on the default branch.',
  empty_diff: 'The plan changed nothing, so a rescan confirms the findings were already fixed.',
}
