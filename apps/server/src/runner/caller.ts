import {
  CALLER_WORKFLOW_DIR,
  FIX_DISPATCH_INPUTS,
  FIX_WORKFLOW,
  LATEST_FIX_WORKFLOW,
  MAJORS_AGENT_SECRET,
  renderCallerWorkflow,
  type RunnerMajorsAgent,
  type RunnerCaller,
  type RunnerCallerState,
} from '@hinomi/shared'
import { parse } from 'yaml'
import { isGithubError, readRepoFile, type GithubClient } from '../sources/github/index.js'

// Caller detection: the workflow file each repo adds, read from its default branch, must call
// the Hinomi reusable workflow pinned by commit SHA and declare the dispatch inputs. Whether it
// passes the majors agent's secret is reported too, for the optional majors job.

/** The release SHA callers should pin, with its version for the YAML comment. */
export interface LatestFixWorkflow {
  sha: string
  version: string
}

const SHA = /^[a-f0-9]{40}$/

/** The facts of a caller file derived from its state, for the status. */
function callerFacts(state: RunnerCallerState, ref: string | null) {
  return {
    present: state !== 'missing' && state !== 'unknown',
    pinnedSha: ref !== null && SHA.test(ref) ? ref : null,
    outdated: state === 'outdated',
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

interface HinomiJob {
  /** The ref after `@`. */
  ref: string
  /** The job hands MAJORS_AGENT_SECRET on (named, or `secrets: inherit`). */
  passesAgentSecret: boolean
}

/** Every job whose `uses:` names the Hinomi reusable workflow. */
function hinomiJobs(jobs: Record<string, unknown> | null): HinomiJob[] {
  if (!jobs) return []
  const prefix = `${FIX_WORKFLOW.toLowerCase()}@`
  return Object.values(jobs).flatMap((value) => {
    const job = record(value)
    const uses = job?.uses
    if (typeof uses !== 'string') return []
    const trimmed = uses.trim()
    if (!trimmed.toLowerCase().startsWith(prefix)) return []
    const secrets = job?.secrets
    const passesAgentSecret =
      secrets === 'inherit' || record(secrets)?.[MAJORS_AGENT_SECRET] !== undefined
    return [{ ref: trimmed.slice(prefix.length), passesAgentSecret }]
  })
}

function declaredInputs(doc: Record<string, unknown>): Set<string> {
  // YAML 1.2 keeps `on` a string key; a YAML 1.1 reader would have made it `true`.
  const on = record(doc.on) ?? record(doc.true)
  const inputs = record(record(on?.workflow_dispatch)?.inputs)
  return new Set(inputs ? Object.keys(inputs) : [])
}

export interface CallerInspection {
  state: Exclude<RunnerCallerState, 'missing' | 'unknown'>
  ref: string | null
  missingInputs: string[]
  passesAgentSecret: boolean
}

/** Reads a caller workflow's text: what it calls, how it is pinned, and its inputs. */
export function inspectCallerWorkflow(
  text: string,
  latest: LatestFixWorkflow | null,
): CallerInspection {
  let doc: Record<string, unknown> | null
  try {
    doc = record(parse(text))
  } catch {
    doc = null
  }
  if (!doc) return { state: 'invalid', ref: null, missingInputs: [], passesAgentSecret: false }
  const inputs = declaredInputs(doc)
  const missingInputs = FIX_DISPATCH_INPUTS.filter((name) => !inputs.has(name))
  const job = hinomiJobs(record(doc.jobs))[0]
  if (!job) return { state: 'not_hinomi', ref: null, missingInputs, passesAgentSecret: false }
  const { ref, passesAgentSecret } = job
  if (!SHA.test(ref)) return { state: 'unpinned', ref, missingInputs, passesAgentSecret }
  if (!latest) return { state: 'pinned', ref, missingInputs, passesAgentSecret }
  const state = ref === latest.sha ? 'current' : 'outdated'
  return { state, ref, missingInputs, passesAgentSecret }
}

function messageFor(
  state: RunnerCallerState,
  path: string,
  ref: string | null,
  missingInputs: string[],
): string {
  const inputs =
    missingInputs.length > 0 ? ` It does not declare the inputs ${missingInputs.join(', ')}.` : ''
  switch (state) {
    case 'missing':
      return `No ${path} on the default branch. Add the workflow below there.`
    case 'invalid':
      return `${path} is not valid YAML.`
    case 'not_hinomi':
      return `${path} does not call ${FIX_WORKFLOW}.${inputs}`
    case 'unpinned':
      return `${path} calls the Hinomi workflow at ${ref ?? 'a moving ref'}; pin it to a commit SHA.${inputs}`
    case 'pinned':
      return `${path} is pinned to ${ref ?? ''}.${inputs}`
    case 'current':
      return `${path} is pinned to the latest release.${inputs}`
    case 'outdated':
      return `${path} is pinned to an older commit; update it to the latest release.${inputs}`
    case 'unknown':
      return `${path} could not be read.`
  }
}

export interface ReadCallerOptions {
  owner: string
  name: string
  workflow: string
  /** The default branch: workflow_dispatch only runs workflows that exist there. */
  ref: string
  latest?: LatestFixWorkflow | null
  /** The repo's majors agent setting: the template passes the secret when it is on. */
  majorsAgent?: RunnerMajorsAgent
}

/** The caller as the status shows it, when the repo could not be read (no source, an error). */
export function unknownCaller(
  workflow: string,
  message: string,
  latest: LatestFixWorkflow | null = LATEST_FIX_WORKFLOW,
  majorsAgent: RunnerMajorsAgent = 'off',
): RunnerCaller {
  return {
    state: 'unknown',
    path: `${CALLER_WORKFLOW_DIR}/${workflow}`,
    ref: null,
    ...callerFacts('unknown', null),
    latestSha: latest?.sha ?? null,
    missingInputs: [],
    message,
    template: renderCallerWorkflow({ file: workflow, ...latest, majorsAgent }),
  }
}

/** Fetches the caller workflow from the default branch and inspects it. Never throws. */
export async function readCaller(
  client: GithubClient,
  options: ReadCallerOptions,
): Promise<RunnerCaller> {
  const latest = options.latest === undefined ? LATEST_FIX_WORKFLOW : options.latest
  const path = `${CALLER_WORKFLOW_DIR}/${options.workflow}`
  const base = {
    path,
    latestSha: latest?.sha ?? null,
    template: renderCallerWorkflow({
      file: options.workflow,
      ...latest,
      majorsAgent: options.majorsAgent ?? 'off',
    }),
  }
  let text: string | null
  try {
    text = await readRepoFile(client, options.owner, options.name, path, options.ref)
  } catch (error) {
    const reason = isGithubError(error, 'permission')
      ? 'The credential may not read repository contents (Contents: read).'
      : error instanceof Error
        ? error.message
        : String(error)
    return unknownCaller(
      options.workflow,
      `${path} could not be read: ${reason}`,
      latest,
      options.majorsAgent,
    )
  }
  if (text === null) {
    return {
      ...base,
      state: 'missing',
      ref: null,
      ...callerFacts('missing', null),
      missingInputs: [],
      passesAgentSecret: false,
      message: messageFor('missing', path, null, []),
    }
  }
  const inspected = inspectCallerWorkflow(text, latest)
  return {
    ...base,
    ...inspected,
    ...callerFacts(inspected.state, inspected.ref),
    message: messageFor(inspected.state, path, inspected.ref, inspected.missingInputs),
  }
}
