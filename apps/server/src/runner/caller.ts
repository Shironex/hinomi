import {
  CALLER_WORKFLOW_DIR,
  FIX_DISPATCH_INPUTS,
  FIX_WORKFLOW,
  LATEST_FIX_WORKFLOW,
  renderCallerWorkflow,
  type RunnerCaller,
  type RunnerCallerState,
} from '@hinomi/shared'
import { parse } from 'yaml'
import { isGithubError, readRepoFile, type GithubClient } from '../sources/github/index.js'

// Caller detection: the workflow file each repo adds, read from its default branch, must call
// the Hinomi reusable workflow pinned by commit SHA and declare the dispatch inputs.

/** The release SHA callers should pin, with its version for the YAML comment. */
export interface LatestFixWorkflow {
  sha: string
  version: string
}

const SHA = /^[a-f0-9]{40}$/

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Every `uses:` of a job that names the Hinomi reusable workflow, as the ref after `@`. */
function hinomiRefs(jobs: Record<string, unknown> | null): string[] {
  if (!jobs) return []
  const prefix = `${FIX_WORKFLOW.toLowerCase()}@`
  return Object.values(jobs).flatMap((job) => {
    const uses = record(job)?.uses
    if (typeof uses !== 'string') return []
    const trimmed = uses.trim()
    return trimmed.toLowerCase().startsWith(prefix) ? [trimmed.slice(prefix.length)] : []
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
  if (!doc) return { state: 'invalid', ref: null, missingInputs: [] }
  const inputs = declaredInputs(doc)
  const missingInputs = FIX_DISPATCH_INPUTS.filter((name) => !inputs.has(name))
  const ref = hinomiRefs(record(doc.jobs))[0] ?? null
  if (ref === null) return { state: 'not_hinomi', ref: null, missingInputs }
  if (!SHA.test(ref)) return { state: 'unpinned', ref, missingInputs }
  if (!latest) return { state: 'pinned', ref, missingInputs }
  return { state: ref === latest.sha ? 'current' : 'outdated', ref, missingInputs }
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
}

/** The caller as the status shows it, when the repo could not be read (no source, an error). */
export function unknownCaller(
  workflow: string,
  message: string,
  latest: LatestFixWorkflow | null = LATEST_FIX_WORKFLOW,
): RunnerCaller {
  return {
    state: 'unknown',
    path: `${CALLER_WORKFLOW_DIR}/${workflow}`,
    ref: null,
    latestSha: latest?.sha ?? null,
    missingInputs: [],
    message,
    template: renderCallerWorkflow({ file: workflow, ...latest }),
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
    template: renderCallerWorkflow({ file: options.workflow, ...latest }),
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
    return unknownCaller(options.workflow, `${path} could not be read: ${reason}`, latest)
  }
  if (text === null) {
    return {
      ...base,
      state: 'missing',
      ref: null,
      missingInputs: [],
      message: messageFor('missing', path, null, []),
    }
  }
  const inspected = inspectCallerWorkflow(text, latest)
  return {
    ...base,
    ...inspected,
    message: messageFor(inspected.state, path, inspected.ref, inspected.missingInputs),
  }
}
