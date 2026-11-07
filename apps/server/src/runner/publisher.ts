import {
  FixPayloadError,
  currentTime,
  isFixRunTerminal,
  renderFixPrBody,
  renderMajorsPrBody,
  type FixPlan,
  type FixPr,
  type FixPrBodyOptions,
  type FixResultV1,
  type FixRunState,
} from '@hinomi/shared'
import type { FixRunRow } from '../db/schema.js'
import type { FixRunEvent, Repositories } from '../repository/index.js'
import {
  GithubError,
  addPullLabels,
  createPull,
  existingLabels,
  fetchRunnerRepoMeta,
  listBranchPulls,
  setPullDraft,
  updatePull,
  type GithubClient,
  type GithubPull,
  type RunnerRepoMeta,
} from '../sources/github/index.js'
import type { RunnerGithub } from './github.js'

// Mode A of the runner design (decision 1): once the workflow pushed `hinomi/fix-plan`, Hinomi
// opens the fix PR with its own credential, or updates the open one, so the repo's CI runs
// without an approval click. The body comes from the shared renderer; links back to Hinomi only
// on private repos with a public base URL. Publishing twice with the same result changes
// nothing on GitHub or in the run.

/** Labels the fix PR gets when the repo already has them. Hinomi never creates labels. */
export const FIX_PR_LABELS = ['dependencies', 'security'] as const

/** Longest failure reason stored on a run. */
const MAX_REASON = 500

/** States a run is in while its branch can still turn into a PR. */
const BEFORE_PR: readonly FixRunState[] = [
  'pending',
  'dispatched',
  'queued',
  'running',
  'branch_pushed',
]
const PR_STATES: readonly FixRunState[] = [
  'pr_open',
  'checks_pending',
  'checks_passing',
  'checks_failing',
  'checks_none',
]

export interface FixPrPublisherOptions {
  repositories: Repositories
  /** The GitHub source to write through, opened per publish. */
  github: () => RunnerGithub
  /** Public address of this Hinomi without a trailing slash, or null when not configured. */
  publicBaseUrl?: () => string | null
  now?: () => Date
}

/** The fix PR as GitHub has it after publishing. */
export interface PublishedPr {
  number: number
  url: string
  draft: boolean
}

export type PublishFixPrOutcome =
  /**
   * The PR is open and matches the result. `action` says what was written: `created` a new PR,
   * `updated` title, body, draft state or labels, `unchanged` nothing (a repeat).
   */
  | {
      kind: 'published'
      run: FixRunRow
      pr: PublishedPr
      action: 'created' | 'updated' | 'unchanged'
      /** The closed unmerged PR the new one replaces, named in its body. */
      replaces: number | null
      /** Labels added in this publish. */
      labelsAdded: string[]
      /** What could not be done without failing the publish (labels, draft state). */
      warnings: string[]
    }
  /**
   * The latest fix PR on the branch was closed without merging and nobody was asked about a
   * fresh one (decision 10). The run is now `closed_unmerged` with that PR, so the next dispatch
   * asks in the UI; nothing was reopened.
   */
  | { kind: 'reopen_required'; run: FixRunRow; previous: PublishedPr }
  /** Nothing to do for this run (it ended, or is past the PR). */
  | { kind: 'skipped'; run: FixRunRow; reason: string }
  /** GitHub could not be reached or was busy. The run is unchanged; publish again later. */
  | { kind: 'retry'; run: FixRunRow; reason: string }
  /** A refusal a person must fix. The run moved to `failed` when it had no PR yet. */
  | { kind: 'failed'; run: FixRunRow; reason: string }

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}.` : text
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True for failures that may pass by themselves: publish again later. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof GithubError)) return false
  if (['network', 'timeout', 'rate_limit'].includes(error.kind)) return true
  return error.kind === 'http' && error.status !== null && error.status >= 500
}

/** A refused GitHub call as a reason a person can act on. */
export function publishFailureReason(
  error: unknown,
  target: { fullName: string; branch: string; base: string },
): string {
  const detail = errorText(error)
  if (error instanceof FixPayloadError) return clip(`The fix result cannot be used: ${detail}`)
  if (!(error instanceof GithubError)) return clip(`The fix PR could not be opened: ${detail}`)
  const { fullName, branch, base } = target
  if (error.kind === 'auth') {
    return clip(`GitHub rejected the credential. Check the GitHub source. ${detail}`)
  }
  if (error.kind === 'permission') {
    return clip(
      `GitHub refused to open or update the fix PR on ${fullName}: the credential needs Pull requests: write (GitHub App or fine grained token) or the repo scope (classic token). ${detail}`,
    )
  }
  if (error.kind === 'not_found') {
    return clip(
      `GitHub answered 404 for the pull requests of ${fullName}: the repo is gone, or the credential cannot see it or lacks Pull requests: write. ${detail}`,
    )
  }
  if (error.status === 422) {
    if (/no commits between/i.test(detail)) {
      return clip(
        `${branch} has no commits ahead of ${base} on ${fullName}, so there is nothing to open a PR for. ${detail}`,
      )
    }
    if (/already exists/i.test(detail)) {
      return clip(
        `A pull request for ${branch} already exists on ${fullName} against another base branch than ${base}. Close it or retarget it to ${base}. ${detail}`,
      )
    }
    if (/head|invalid|not exist/i.test(detail)) {
      return clip(
        `GitHub found no branch ${branch} on ${fullName}: the workflow did not push it, or it was deleted. ${detail}`,
      )
    }
    return clip(`GitHub rejected the fix PR on ${fullName}. ${detail}`)
  }
  return clip(`The fix PR could not be opened on ${fullName}: ${detail}`)
}

/** The run's fix run page, sent only for private repos with a public base URL. */
function hinomiLink(
  meta: RunnerRepoMeta,
  run: FixRunRow,
  publicBaseUrl: string | null,
): { linksAllowed: boolean; hinomiUrl?: string } {
  if (meta.visibility !== 'private' || !publicBaseUrl) return { linksAllowed: false }
  return { linksAllowed: true, hinomiUrl: `${publicBaseUrl}/fix-runs?sel=${run.id}` }
}

/** The open PR to update: the one the run tracks, else Hinomi's for this repo, else the first. */
function pickOpen(open: GithubPull[], run: FixRunRow): GithubPull | undefined {
  const marker = `<!-- hinomi:${run.kind} repo=${run.repoId} `
  return (
    open.find((pr) => pr.number === run.prNumber) ??
    open.find((pr) => pr.body.includes(marker)) ??
    open[0]
  )
}

/** The PR of a run: the fix PR, or for a majors run the agent's PR (always a draft). */
function renderPr(
  run: FixRunRow,
  plan: FixPlan,
  result: FixResultV1,
  options: FixPrBodyOptions,
): FixPr {
  return run.kind === 'majors'
    ? renderMajorsPrBody(plan, result, options)
    : renderFixPrBody(plan, result, options)
}

/** The most recently closed PR of the branch. */
function lastClosed(closed: GithubPull[]): GithubPull | undefined {
  return [...closed].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))[0]
}

function asPublished(pr: GithubPull): PublishedPr {
  return { number: pr.number, url: pr.url, draft: pr.draft }
}

interface Context {
  options: FixPrPublisherOptions
  client: GithubClient
  meta: RunnerRepoMeta
  run: FixRunRow
  now: () => Date
}

/** Applies events in order, stopping at the first rejection. */
function applyEvents(
  { options, now }: Context,
  run: FixRunRow,
  events: FixRunEvent[],
): { ok: true; run: FixRunRow } | { ok: false; run: FixRunRow; message: string } {
  let current = run
  for (const event of events) {
    const applied = options.repositories.fixRuns.applyEvent(current.id, event, now())
    if (!applied.ok) return { ok: false, run: current, message: applied.rejection.message }
    current = applied.run
  }
  return { ok: true, run: current }
}

interface FailDeps {
  options: Pick<FixPrPublisherOptions, 'repositories'>
  now: () => Date
}

/** Fails the run when it has no PR yet; a run with a PR keeps its state and only reports. */
function fail({ options, now }: FailDeps, run: FixRunRow, reason: string): PublishFixPrOutcome {
  if (!BEFORE_PR.includes(run.state)) return { kind: 'failed', run, reason }
  const applied = options.repositories.fixRuns.applyEvent(run.id, { type: 'failed', reason }, now())
  return { kind: 'failed', run: applied.ok ? applied.run : run, reason }
}

/** Adds the fix labels the repo has and the PR lacks. A refusal is a warning, not a failure. */
async function syncLabels(
  { client, meta }: Context,
  pr: GithubPull,
  warnings: string[],
): Promise<string[]> {
  const lacking = FIX_PR_LABELS.filter((label) => !pr.labels.includes(label))
  if (lacking.length === 0) return []
  try {
    const labels = await existingLabels(client, meta.owner, meta.name, lacking)
    if (labels.length === 0) return []
    await addPullLabels(client, { owner: meta.owner, name: meta.name, number: pr.number, labels })
    return labels
  } catch (error) {
    if (isTransient(error)) throw error
    warnings.push(`The labels could not be added: ${errorText(error)}`)
    return []
  }
}

/** Sets the draft state; returns the state the PR ends up in. A refusal is a warning. */
async function syncDraft(
  { client }: Context,
  pr: GithubPull,
  draft: boolean,
  warnings: string[],
): Promise<boolean> {
  if (pr.draft === draft) return draft
  try {
    await setPullDraft(client, pr.nodeId, draft)
    return draft
  } catch (error) {
    if (isTransient(error)) throw error
    const wanted = draft ? 'a draft' : 'ready for review'
    warnings.push(`The PR could not be marked ${wanted}: ${errorText(error)}`)
    return pr.draft
  }
}

async function updateOpen(
  context: Context,
  run: FixRunRow,
  pr: GithubPull,
  rendered: FixPr,
): Promise<PublishFixPrOutcome> {
  const { client, meta } = context
  if (run.prNumber !== null && run.prNumber !== pr.number) {
    const reason = `The run tracks PR #${run.prNumber}, but the open fix PR on ${meta.fullName} is #${pr.number}.`
    return { kind: 'failed', run, reason }
  }
  const warnings: string[] = []
  let wrote = false
  if (pr.title !== rendered.title || pr.body !== rendered.body) {
    const updated = await updatePull(client, {
      owner: meta.owner,
      name: meta.name,
      number: pr.number,
      title: rendered.title,
      body: rendered.body,
    })
    pr = updated
    wrote = true
  }
  const draft = await syncDraft(context, pr, rendered.draft, warnings)
  wrote ||= draft !== pr.draft
  const labelsAdded = await syncLabels(context, pr, warnings)
  wrote ||= labelsAdded.length > 0
  const published = { number: pr.number, url: pr.url, draft }
  const events: FixRunEvent[] = []
  if (run.prNumber === null) {
    events.push({ type: 'pr_opened', number: pr.number, url: pr.url, draft })
  }
  events.push({ type: 'pr_draft_changed', draft })
  const applied = applyEvents(context, run, events)
  if (!applied.ok) return { kind: 'failed', run: applied.run, reason: applied.message }
  return {
    kind: 'published',
    run: applied.run,
    pr: published,
    action: wrote ? 'updated' : 'unchanged',
    replaces: null,
    labelsAdded,
    warnings,
  }
}

async function createFresh(
  context: Context,
  run: FixRunRow,
  rendered: FixPr,
  replaces: number | null,
): Promise<PublishFixPrOutcome> {
  const { client, meta } = context
  const pr = await createPull(client, {
    owner: meta.owner,
    name: meta.name,
    title: rendered.title,
    body: rendered.body,
    head: run.branch,
    base: meta.defaultBranch,
    draft: rendered.draft,
  })
  const warnings: string[] = []
  const labelsAdded = await syncLabels(context, pr, warnings)
  const applied = applyEvents(context, run, [
    { type: 'pr_opened', number: pr.number, url: pr.url, draft: pr.draft },
  ])
  if (!applied.ok) return { kind: 'failed', run: applied.run, reason: applied.message }
  return {
    kind: 'published',
    run: applied.run,
    pr: asPublished(pr),
    action: 'created',
    replaces,
    labelsAdded,
    warnings,
  }
}

/**
 * A fix PR was closed without merging. The run takes it on (when it did not track it yet) and
 * ends `closed_unmerged`, so the next dispatch asks in the UI; nothing is reopened.
 */
function endClosed(context: Context, run: FixRunRow, closed: GithubPull): PublishFixPrOutcome {
  const events: FixRunEvent[] = []
  if (run.prNumber === null) {
    events.push({ type: 'pr_opened', number: closed.number, url: closed.url, draft: closed.draft })
  }
  events.push({ type: 'pr_closed' })
  const applied = applyEvents(context, run, events)
  if (!applied.ok) return { kind: 'failed', run, reason: applied.message }
  return { kind: 'reopen_required', run: applied.run, previous: asPublished(closed) }
}

/** The run tracks a PR that is no longer open: merged, or closed by a person. */
function trackedGone(context: Context, run: FixRunRow, closed: GithubPull[]): PublishFixPrOutcome {
  const own = closed.find((pr) => pr.number === run.prNumber)
  if (own?.merged) {
    return { kind: 'skipped', run, reason: `PR #${own.number} was merged.` }
  }
  if (own) return endClosed(context, run, own)
  const reason = `PR #${run.prNumber} is no longer a pull request of ${run.branch} on ${context.meta.fullName}.`
  return { kind: 'failed', run, reason }
}

async function publish(
  context: Context,
  result: FixResultV1,
  headSha: string,
): Promise<PublishFixPrOutcome> {
  const { options, client, meta } = context
  let run = context.run

  if (result.runId !== run.correlationId) {
    return fail(context, run, `The fix result is for run ${result.runId}, not this run.`)
  }
  const planRow = options.repositories.fixPlans.forRepo(run.repoId, run.planScanRunId)
  if (!planRow) {
    return fail(context, run, 'The plan of this run was pruned, so the PR body cannot be written.')
  }
  if (BEFORE_PR.includes(run.state)) {
    const pushed = applyEvents(context, run, [{ type: 'branch_pushed', headSha }])
    if (!pushed.ok) return { kind: 'failed', run, reason: pushed.message }
    run = pushed.run
  }

  // GitHub's spelling of the repo, which the runner wrote into the result.
  const plan = {
    ...planRow.plan,
    repo: { ...planRow.plan.repo, owner: meta.owner, name: meta.name, fullName: meta.fullName },
  }
  const query = { owner: meta.owner, name: meta.name, branch: run.branch, base: meta.defaultBranch }
  const open = pickOpen(await listBranchPulls(client, { ...query, state: 'open' }), run)
  const link = hinomiLink(meta, run, options.publicBaseUrl?.() ?? null)
  if (open) return updateOpen(context, run, open, renderPr(run, plan, result, link))

  const closedPulls = await listBranchPulls(client, { ...query, state: 'closed' })
  if (run.prNumber !== null) return trackedGone(context, run, closedPulls)
  // Decision 10: a fresh PR replaces a closed unmerged one only when Hinomi recorded the closure
  // before this run was dispatched, so the dispatch asked first.
  const closed = lastClosed(closedPulls)
  let replaces: number | null = null
  if (closed && !closed.merged) {
    const asked = options.repositories.fixRuns.closedUnmergedPr(
      run.repoId,
      run.kind,
      closed.number,
      run,
    )
    if (!asked) return endClosed(context, run, closed)
    replaces = closed.number
  }
  const rendered = renderPr(run, plan, result, {
    ...link,
    ...(replaces !== null && { replaces }),
  })
  return createFresh(context, run, rendered, replaces)
}

/**
 * Opens or updates the fix PR of a run whose workflow pushed its branch (mode A). Called by the
 * run tracker once it read the run's result artifact, with the decoded result and the head SHA
 * of the pushed branch:
 *
 * - records `branch_pushed`, then finds the open PR of the branch (head `<owner>:<branch>`, base
 *   the default branch) and updates its title, body, draft state and labels, or opens one;
 * - records `pr_opened` and `pr_draft_changed` with the PR's number, URL and draft state;
 * - adds `dependencies` and `security` only when the repo has them;
 * - never reopens a PR closed without merging: with the reopen question answered at dispatch it
 *   opens a fresh PR that names the closed one, else it ends the run `closed_unmerged`.
 *
 * Never throws for GitHub errors: a refusal fails the run (403, 404, 422 with the reason), a
 * transient error leaves it for another try. Writes are never retried.
 */
export async function publishFixPr(
  options: FixPrPublisherOptions,
  run: FixRunRow,
  result: FixResultV1,
  headSha: string,
): Promise<PublishFixPrOutcome> {
  const now = options.now ?? currentTime
  if (isFixRunTerminal(run.state)) {
    return { kind: 'skipped', run, reason: `The run is ${run.state}.` }
  }
  if (!BEFORE_PR.includes(run.state) && !PR_STATES.includes(run.state)) {
    return { kind: 'skipped', run, reason: `The run is ${run.state}, past its PR.` }
  }
  const github = options.github()
  if (!github.ok) return { kind: 'retry', run, reason: github.message }
  const client = github.source.client

  let meta: RunnerRepoMeta
  try {
    const repo = options.repositories.repos.get(run.repoId)
    if (!repo) return { kind: 'skipped', run, reason: 'The repo was removed.' }
    meta = await fetchRunnerRepoMeta(client, repo.owner, repo.name)
  } catch (error) {
    const reason = `GitHub could not be asked about the repo: ${errorText(error)}`
    if (isTransient(error)) return { kind: 'retry', run, reason }
    return fail({ options, now }, run, clip(reason))
  }

  const context: Context = { options, client, meta, run, now }
  try {
    return await publish(context, result, headSha)
  } catch (error) {
    const latest = options.repositories.fixRuns.get(run.id) ?? run
    const target = { fullName: meta.fullName, branch: run.branch, base: meta.defaultBranch }
    const reason = publishFailureReason(error, target)
    if (isTransient(error)) return { kind: 'retry', run: latest, reason }
    return fail(context, latest, reason)
  }
}
