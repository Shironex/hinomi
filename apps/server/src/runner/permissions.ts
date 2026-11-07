import type {
  RunnerAuth,
  RunnerPermission,
  RunnerPermissionStatus,
  RunnerPermissions,
} from '@hinomi/shared'
import {
  isGithubAppSource,
  probeContentsRead,
  probePullsRead,
  probeWorkflowRead,
  testGithubConnection,
  type GithubSource,
  type ProbeOutcome,
} from '../sources/github/index.js'

// The runner permission probe. Scans stay read only; the runner needs writes, so it checks them
// separately and only for repos with the runner on (section 3.2 of the runner design).

interface PermissionSpec {
  name: string
  label: string
  purpose: string
  required: boolean
}

const DISPATCH = 'dispatch the fix workflow and follow its runs'
const PULL_REQUEST = 'open and update the fix pull request'
const CONTENTS = 'read the caller workflow and the pushed fix branch'
const SETUP = 'open the setup pull request that adds the caller workflow (optional)'
const CHECKS = 'follow the checks on the fix pull request'

/** What the runner needs from a GitHub App installation, with the level. */
export const RUNNER_APP_PERMISSIONS: readonly (PermissionSpec & { level: 'read' | 'write' })[] = [
  { name: 'actions', level: 'write', label: 'Actions: write', purpose: DISPATCH, required: true },
  { name: 'contents', level: 'read', label: 'Contents: read', purpose: CONTENTS, required: true },
  {
    name: 'pull_requests',
    level: 'write',
    label: 'Pull requests: write',
    purpose: PULL_REQUEST,
    required: true,
  },
  { name: 'checks', level: 'read', label: 'Checks: read', purpose: CHECKS, required: false },
  {
    name: 'statuses',
    level: 'read',
    label: 'Commit statuses: read',
    purpose: CHECKS,
    required: false,
  },
  { name: 'workflows', level: 'write', label: 'Workflows: write', purpose: SETUP, required: false },
]

function item(spec: PermissionSpec, status: RunnerPermissionStatus): RunnerPermission {
  return {
    name: spec.name,
    label: spec.label,
    purpose: spec.purpose,
    required: spec.required,
    status,
  }
}

function summarize(
  auth: RunnerAuth,
  items: RunnerPermission[],
  canOpenSetupPr: boolean,
): RunnerPermissions {
  const missing = items.filter((i) => i.required && i.status === 'missing')
  const unverified = items.filter((i) => i.required && i.status === 'unverified')
  let message: string
  if (missing.length > 0) {
    message = `Missing ${missing.map((i) => i.label).join(', ')}.`
  } else if (unverified.length > 0) {
    message = `Reads work. ${unverified.map((i) => i.label).join(', ')} cannot be checked without a write; make sure the token grants them.`
  } else {
    message = 'The credential has every permission the runner needs.'
  }
  return { auth, ok: missing.length === 0, canOpenSetupPr, items, message }
}

const granted = (level: string | undefined, needed: 'read' | 'write'): boolean =>
  needed === 'read' ? level === 'read' || level === 'write' : level === 'write'

/** A GitHub App: the installation's granted permissions say it all. */
export function appPermissions(permissions: Record<string, string>): RunnerPermissions {
  const items = RUNNER_APP_PERMISSIONS.map((spec) =>
    item(spec, granted(permissions[spec.name], spec.level) ? 'granted' : 'missing'),
  )
  const canOpenSetupPr =
    granted(permissions.workflows, 'write') && granted(permissions.contents, 'write')
  return summarize('github_app', items, canOpenSetupPr)
}

/**
 * A classic token: `repo` covers dispatch, contents and pull requests (`public_repo` is enough
 * on a public repo); `workflow` lets it write workflow files for the setup PR.
 */
export function classicTokenPermissions(
  scopes: readonly string[],
  visibility: 'public' | 'private' | null,
): RunnerPermissions {
  const has = new Set(scopes)
  const repoOk = has.has('repo') || (visibility === 'public' && has.has('public_repo'))
  const workflowOk = has.has('workflow')
  const items = [
    item(
      {
        name: 'repo',
        label: visibility === 'public' ? 'repo (or public_repo)' : 'repo',
        purpose: `${DISPATCH}, ${PULL_REQUEST}`,
        required: true,
      },
      repoOk ? 'granted' : 'missing',
    ),
    item(
      { name: 'workflow', label: 'workflow', purpose: SETUP, required: false },
      workflowOk ? 'granted' : 'missing',
    ),
  ]
  return summarize('classic_token', items, repoOk && workflowOk)
}

/** Read probes of a fine grained token, mapped to what they prove. */
export interface FineGrainedProbes {
  /** GET the caller workflow's metadata (Actions read). */
  workflow: ProbeOutcome
  /** List one pull request (Pull requests read). */
  pulls: ProbeOutcome
  /** List one commit (Contents read). */
  contents: ProbeOutcome
}

/**
 * A fine grained token cannot be asked what it may do. Harmless reads show whether a
 * permission is there at all; a read that works leaves the write level unverified until the
 * first dispatch. A 404 on the workflow only says the file is missing (the caller check reports
 * that), so the Actions permission stays unverified then.
 */
export function fineGrainedPermissions(probes: FineGrainedProbes): RunnerPermissions {
  const writeStatus = (outcome: ProbeOutcome): RunnerPermissionStatus =>
    outcome === 'denied' ? 'missing' : 'unverified'
  const items = [
    item(
      { name: 'actions', label: 'Actions: write', purpose: DISPATCH, required: true },
      writeStatus(probes.workflow),
    ),
    item(
      { name: 'contents', label: 'Contents: read', purpose: CONTENTS, required: true },
      probes.contents === 'denied' ? 'missing' : 'granted',
    ),
    item(
      {
        name: 'pull_requests',
        label: 'Pull requests: write',
        purpose: PULL_REQUEST,
        required: true,
      },
      writeStatus(probes.pulls),
    ),
    item(
      { name: 'workflows', label: 'Workflows: write', purpose: SETUP, required: false },
      'unverified',
    ),
  ]
  return summarize('fine_grained_token', items, false)
}

/** Token prefixes GitHub documents: `ghp_` classic, `github_pat_` fine grained. */
function tokenKind(token: string, scopes: string[] | null): Exclude<RunnerAuth, 'github_app'> {
  if (token.startsWith('github_pat_')) return 'fine_grained_token'
  if (token.startsWith('ghp_')) return 'classic_token'
  // Other tokens (OAuth, GitHub Enterprise): classic ones report X-OAuth-Scopes.
  return scopes === null ? 'fine_grained_token' : 'classic_token'
}

export interface ProbeTarget {
  owner: string
  name: string
  workflow: string
  visibility: 'public' | 'private' | null
}

/** Probes the credential for the runner. Throws a GithubError when GitHub cannot be asked. */
export async function probeRunnerPermissions(
  source: GithubSource,
  target: ProbeTarget,
): Promise<RunnerPermissions> {
  if (isGithubAppSource(source)) {
    const installation = await source.app.installation()
    return appPermissions(installation.permissions)
  }
  const [token, connection] = await Promise.all([
    source.getToken(),
    testGithubConnection(source.client),
  ])
  if (tokenKind(token, connection.scopes) === 'classic_token') {
    return classicTokenPermissions(connection.scopes ?? [], target.visibility)
  }
  const [workflow, pulls, contents] = await Promise.all([
    probeWorkflowRead(source.client, target.owner, target.name, target.workflow),
    probePullsRead(source.client, target.owner, target.name),
    probeContentsRead(source.client, target.owner, target.name),
  ])
  return fineGrainedPermissions({ workflow, pulls, contents })
}
