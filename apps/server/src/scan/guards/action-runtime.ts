import {
  SOURCE_KINDS,
  type ActionRuntimeEntry,
  type ActionRuntimeEvidence,
  type GuardResult,
} from '@hinomi/shared'
import { windowStateOf, type SupportIndex } from '../../support/index.js'
import type { RepoRow } from '../../db/schema.js'
import {
  nodeLineOfUsing,
  parseActionManifest,
  parseWorkflowUses,
  type ActionManifest,
  type ActionUse,
} from './action-manifest.js'
import type { RepoFileReader } from './repo-files.js'
import { supportLineOf, worstResult } from './runtime-lines.js'
import type { Guard, GuardSubjectResult } from './types.js'

// action_runtime (docs/design/phase-2.md section 5.4, decision Q13): the Node line each action runs
// on, for the repo's own `action.yml` and every action its workflows use (`uses: owner/repo@ref`).
// `runs.using: node20` gives line 20, judged like a Node pin: past end of security support fails,
// inside the warning window warns. `docker` and `composite` give nothing themselves; a composite
// action is followed one level, to the actions its own steps use.

const DAY_MS = 24 * 60 * 60 * 1000
/** An action read at a tag or branch is kept this long; a sha is kept for good. */
const TAG_CACHE_MS = DAY_MS
/** Most distinct actions one repo reads per scan, so a huge monorepo cannot flood the API. */
export const MAX_ACTIONS = 100
const MAX_WORKFLOWS = 50
const WORKFLOW_DIR = '.github/workflows'
const WORKFLOW_FILE = /\.ya?ml$/i

interface Reading {
  repo: RepoRow
  files: RepoFileReader
  support: SupportIndex
  now: Date
  windowDays: number
  /** Reads that failed (rate limit, network): the finding is then not trusted to pass. */
  failures: string[]
}

/** `action.yml`, else `action.yaml`, of the action's folder; null when neither exists. */
async function readManifest(
  reading: Reading,
  at: RepoRow,
  subpath: string,
  ref: string,
  maxAgeMs?: number,
): Promise<ActionManifest | null> {
  for (const name of ['action.yml', 'action.yaml']) {
    const path = subpath === '' ? name : `${subpath}/${name}`
    const read = await reading.files.read(at, path, ref, maxAgeMs === undefined ? {} : { maxAgeMs })
    if (read.status === 'error') {
      reading.failures.push(`${at.owner}/${at.name}@${ref}: ${read.reason}`)
      return null
    }
    if (read.status === 'ok') return parseActionManifest(read.text)
  }
  return null
}

function judge(
  reading: Reading,
  using: string,
  site: { action: string; workflowPath: string | null; workflowLine: number | null },
): ActionRuntimeEntry | null {
  const line = nodeLineOfUsing(using)
  if (line === null) return null
  const product = reading.support.product('nodejs')
  const release = reading.support.line('nodejs', line)
  const base = { ...site, using }
  if (!product || !release) return { ...base, result: 'unknown', support: null }
  const state = windowStateOf(release, reading.now, reading.windowDays)
  const result: GuardResult = state === 'eol' ? 'fail' : state === 'ending' ? 'warn' : 'pass'
  return { ...base, result, support: supportLineOf(product, release, reading.now) }
}

/** The repo hosting an action: this repo's row with the action's name, read through its source. */
const hostOf = (repo: RepoRow, use: ActionUse): RepoRow => ({
  ...repo,
  owner: use.owner,
  name: use.repo,
})

/** The entries of one action: its own runtime, or (composite) the runtimes of its steps' actions. */
async function entriesOf(
  reading: Reading,
  manifest: ActionManifest,
  site: { action: string; workflowPath: string | null; workflowLine: number | null },
  budget: { left: number },
): Promise<ActionRuntimeEntry[]> {
  if (manifest.using !== 'composite') {
    const entry = judge(reading, manifest.using ?? '', site)
    return entry ? [entry] : []
  }
  // One level: the actions a composite action's steps use, not theirs.
  const entries: ActionRuntimeEntry[] = []
  for (const use of manifest.uses) {
    if (budget.left <= 0) break
    budget.left -= 1
    const nested = await readManifest(
      reading,
      hostOf(reading.repo, use),
      use.subpath,
      use.ref,
      TAG_CACHE_MS,
    )
    const entry = nested?.using
      ? judge(reading, nested.using, { ...site, action: `${use.raw} (via ${site.action})` })
      : null
    if (entry) entries.push(entry)
  }
  return entries
}

/** The finding of one repo at the ref its pins were read at. Null leaves the row alone. */
export async function actionRuntimeResult(
  repo: RepoRow,
  ref: string,
  files: RepoFileReader,
  support: SupportIndex,
  options: { now: Date; windowDays: number },
): Promise<GuardSubjectResult | null> {
  const reading: Reading = {
    repo,
    files,
    support,
    now: options.now,
    windowDays: options.windowDays,
    failures: [],
  }
  const entries: ActionRuntimeEntry[] = []
  const budget = { left: MAX_ACTIONS }

  const listing = await files.list(repo, WORKFLOW_DIR, ref)
  if (listing.status === 'error') return null
  if (listing.status === 'no_source') {
    return {
      subject: { repoId: repo.id },
      level: 'unknown',
      evidence: {
        check: 'action_runtime',
        actions: [],
        reason: 'No GitHub source can read this repo, so its workflows were not read.',
      },
    }
  }

  // The repo's own action.yml.
  const own = await readManifest(reading, repo, '', ref)
  if (own) {
    entries.push(
      ...(await entriesOf(
        reading,
        own,
        { action: 'self', workflowPath: null, workflowLine: null },
        budget,
      )),
    )
  }

  const workflows =
    listing.status === 'ok'
      ? listing.paths.filter((p) => WORKFLOW_FILE.test(p)).slice(0, MAX_WORKFLOWS)
      : []
  for (const path of workflows) {
    const read = await files.read(repo, path, ref)
    if (read.status === 'error') {
      reading.failures.push(`${path}: ${read.reason}`)
      continue
    }
    if (read.status !== 'ok') continue
    for (const use of parseWorkflowUses(read.text)) {
      if (budget.left <= 0) break
      budget.left -= 1
      const manifest = await readManifest(
        reading,
        hostOf(repo, use),
        use.subpath,
        use.ref,
        TAG_CACHE_MS,
      )
      if (!manifest) continue
      entries.push(
        ...(await entriesOf(
          reading,
          manifest,
          { action: use.raw, workflowPath: path, workflowLine: use.line },
          budget,
        )),
      )
    }
  }

  const level = worstResult(entries.map((e) => e.result))
  const incomplete = reading.failures.length > 0
  const reason = incomplete
    ? `Some files could not be read this scan (${reading.failures.slice(0, 3).join('; ')}).`
    : budget.left <= 0
      ? `Only the first ${MAX_ACTIONS} actions were read.`
      : null
  // A clean pass needs every read to have worked; a failure never turns into "nothing found".
  if (incomplete && level === 'pass') return null
  const evidence: ActionRuntimeEvidence = { check: 'action_runtime', actions: entries, reason }
  return { subject: { repoId: repo.id }, level, evidence }
}

export const actionRuntimeGuard: Guard = {
  check: 'action_runtime',
  // Workflows and action files come from the repo's GitHub source, whatever deploys it.
  capabilities: Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 'full' as const])),
  async run(ctx) {
    // No support data yet: leave every row as it is.
    if (ctx.support === null) return []
    const options = { now: ctx.now, windowDays: ctx.supportWindowDays }
    const results: GuardSubjectResult[] = []
    for (const repo of ctx.repos) {
      // The ref the scan read the repo at; a repo whose pins were never read is left alone.
      const ref = ctx.scans.get(repo.id)?.pins?.ref
      if (!ref) continue
      const result = await actionRuntimeResult(repo, ref, ctx.repoFiles, ctx.support, options)
      if (result) results.push(result)
    }
    return results
  },
}
