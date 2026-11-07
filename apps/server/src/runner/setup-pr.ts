import {
  CALLER_WORKFLOW_DIR,
  FIX_WORKFLOW,
  MAJORS_AGENT_SECRET,
  SETUP_PR_BRANCH,
  renderCallerWorkflow,
  type RunnerPermissions,
  type RunnerSetupPr,
  type SetupPrResponse,
} from '@hinomi/shared'
import type { RepoRow } from '../db/schema.js'
import {
  createBranch,
  createPull,
  fetchBranchHead,
  fetchRunnerRepoMeta,
  isGithubError,
  listBranchPulls,
  putRepoFile,
  readRepoFile,
  readRepoFileWithSha,
  updatePull,
  type GithubClient,
  type GithubPull,
  type RunnerRepoMeta,
} from '../sources/github/index.js'
import type { LatestFixWorkflow } from './caller.js'
import { callerWorkflowOf } from './github-actions.js'
import type { RunnerGithub } from './github.js'
import { probeRunnerPermissions } from './permissions.js'

// The setup PR: adds the caller workflow to a repo, or moves its pin to the latest release,
// through a branch and a pull request. Needs the Workflows write permission (a classic token's
// `workflow` scope), which is why it is a button and never automatic.

const DOCS = 'https://github.com/Shironex/hinomi/blob/main/docs/github.md#fix-runner'
const WORKFLOWS_HINT =
  'The credential must be allowed to write workflow files: Contents: write and Workflows: write (GitHub App or fine grained token), or the workflow scope (classic token).'

/** Whether the setup PR can work, from the probed permissions. Pure. */
export function setupPrCapability(
  permissions: RunnerPermissions,
  meta: RunnerRepoMeta | null,
): RunnerSetupPr {
  if (!meta || permissions.auth === null) return { available: false, reason: permissions.message }
  const refused = permissions.items.filter(
    (i) => i.status === 'missing' && ['repo', 'contents', 'pull_requests'].includes(i.name),
  )
  if (refused.length > 0) {
    return {
      available: false,
      reason: `Missing ${refused.map((i) => i.label).join(', ')}, which the setup PR needs to open the pull request.`,
    }
  }
  if (permissions.canOpenSetupPr) {
    return { available: true, reason: 'The credential may write workflow files.' }
  }
  switch (permissions.auth) {
    case 'classic_token':
      return {
        available: false,
        reason: 'A classic token needs the workflow scope as well as repo to add a workflow file.',
      }
    case 'github_app':
      return {
        available: false,
        reason:
          'The installation needs Contents: write and Workflows: write, and its owner must accept them on GitHub.',
      }
    case 'fine_grained_token':
      return {
        available: true,
        reason:
          'Workflows: write and Contents: write cannot be checked in advance on a fine grained token. Hinomi tries, and says so if GitHub refuses.',
      }
  }
}

export interface SetupPrRefusal {
  kind: 'refused'
  status: 404 | 409 | 503
  code: 'not_found' | 'conflict' | 'unavailable'
  message: string
}

export type SetupPrResult =
  { kind: 'done'; created: boolean; response: SetupPrResponse } | SetupPrRefusal

function refuse(status: SetupPrRefusal['status'], message: string): SetupPrRefusal {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'unavailable'
  return { kind: 'refused', status, code, message }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A refused GitHub call as an answer a person can act on. */
function failure(error: unknown, fullName: string): SetupPrRefusal {
  if (isGithubError(error, 'permission') || isGithubError(error, 'not_found')) {
    // A token without the workflow permission is told 403 or 404 depending on the route.
    return refuse(
      409,
      `GitHub refused to write to ${fullName}. ${WORKFLOWS_HINT} (${errorText(error)})`,
    )
  }
  return refuse(503, `The setup PR could not be opened on ${fullName}: ${errorText(error)}`)
}

function titleOf(update: boolean): string {
  return update
    ? 'ci(hinomi): update the pin of the hinomi fix runner'
    : 'ci(hinomi): add the hinomi fix runner'
}

function bodyOf(
  path: string,
  latest: LatestFixWorkflow,
  update: { from: string | null } | null,
  majorsAgent: boolean,
): string {
  const lead = update
    ? `Moves the Hinomi fix runner in \`${path}\` to the latest release${update.from ? ` (from \`${update.from}\`)` : ''}.`
    : `Adds the Hinomi fix runner caller workflow, \`${path}\`.`
  return [
    lead,
    '',
    `The file declares the dispatch inputs and calls \`${FIX_WORKFLOW}\`, pinned to the commit \`${latest.sha}\` (${latest.version}). It runs only when Hinomi dispatches it. It must be on the default branch for that to work.`,
    '',
    ...(majorsAgent
      ? [
          `The optional majors agent is on in Hinomi, so the file hands the \`${MAJORS_AGENT_SECRET}\` repository secret to the reusable workflow. Add that secret in the repo settings; without it majors runs fail.`,
          '',
        ]
      : []),
    `Setup and permissions: ${DOCS}`,
  ].join('\n')
}

export interface OpenSetupPrOptions {
  repo: RepoRow
  github: RunnerGithub
  /** The release commit to pin, null when none is known. */
  latest: LatestFixWorkflow | null
}

/**
 * Opens (or finds again) the setup PR. Refuses with 409 when no release SHA is known or the
 * credential is known not to write workflows; with 503 when GitHub fails. Safe to repeat:
 * the branch and an open PR are reused, and a caller already current opens nothing.
 */
export async function openSetupPr(options: OpenSetupPrOptions): Promise<SetupPrResult> {
  const { repo, github, latest } = options
  const fullName = `${repo.owner}/${repo.name}`
  if (!github.ok) return refuse(409, github.message)
  if (!latest) {
    return refuse(
      409,
      'No Hinomi release SHA is known yet, so there is nothing to pin. Pin a release commit by hand, or retry once this instance can reach api.github.com.',
    )
  }
  const client: GithubClient = github.source.client
  const workflow = callerWorkflowOf(repo)
  const path = `${CALLER_WORKFLOW_DIR}/${workflow}`
  // With the majors agent on, the file also hands ANTHROPIC_API_KEY to the reusable workflow.
  const text = renderCallerWorkflow({
    file: workflow,
    sha: latest.sha,
    version: latest.version,
    majorsAgent: repo.runnerMajorsAgent,
  })

  let meta: RunnerRepoMeta
  try {
    meta = await fetchRunnerRepoMeta(client, repo.owner, repo.name)
  } catch (error) {
    return refuse(503, `GitHub could not be asked about ${fullName}: ${errorText(error)}`)
  }
  const base = meta.defaultBranch
  const done = (outcome: SetupPrResponse['outcome'], pr: GithubPull | null): SetupPrResult => ({
    kind: 'done',
    created: outcome === 'created',
    response: {
      outcome,
      pr: pr && { number: pr.number, url: pr.url },
      path,
      sha: latest.sha,
      version: latest.version,
    },
  })

  try {
    const onDefault = await readRepoFile(client, meta.owner, meta.name, path, base)
    if (onDefault === text) return done('already_set_up', null)

    const permissions = await probeRunnerPermissions(github.source, {
      owner: meta.owner,
      name: meta.name,
      workflow,
      visibility: meta.visibility,
    })
    const capability = setupPrCapability(permissions, meta)
    if (!capability.available) return refuse(409, capability.reason)

    // The branch, from the default branch head unless an earlier call made it.
    if ((await fetchBranchHead(client, meta.owner, meta.name, SETUP_PR_BRANCH)) === null) {
      const head = await fetchBranchHead(client, meta.owner, meta.name, base)
      if (head === null) return refuse(503, `GitHub found no branch ${base} on ${fullName}.`)
      await createBranch(client, meta.owner, meta.name, SETUP_PR_BRANCH, head)
    }

    const onBranch = await readRepoFileWithSha(client, meta.owner, meta.name, path, SETUP_PR_BRANCH)
    if (onBranch?.text !== text) {
      await putRepoFile(client, {
        owner: meta.owner,
        name: meta.name,
        path,
        branch: SETUP_PR_BRANCH,
        text,
        message: `ci(hinomi): ${onDefault === null ? 'add' : 'update'} the hinomi fix runner`,
        ...(onBranch && { sha: onBranch.sha }),
      })
    }

    const update =
      onDefault === null ? null : { from: /@([a-f0-9]{40})\b/.exec(onDefault)?.[1] ?? null }
    const title = titleOf(update !== null)
    const body = bodyOf(path, latest, update, repo.runnerMajorsAgent !== 'off')
    const query = { owner: meta.owner, name: meta.name, branch: SETUP_PR_BRANCH, base }
    const open = (await listBranchPulls(client, { ...query, state: 'open' }))[0]
    if (open) {
      const pr =
        open.title === title && open.body === body
          ? open
          : await updatePull(client, {
              owner: meta.owner,
              name: meta.name,
              number: open.number,
              title,
              body,
            })
      return done('updated', pr)
    }
    try {
      const pr = await createPull(client, {
        ...query,
        title,
        body,
        head: SETUP_PR_BRANCH,
        draft: false,
      })
      return done('created', pr)
    } catch (error) {
      // A second click may have opened it between the list and the create.
      const raced = (await listBranchPulls(client, { ...query, state: 'open' }))[0]
      if (raced) return done('updated', raced)
      throw error
    }
  } catch (error) {
    return failure(error, fullName)
  }
}
