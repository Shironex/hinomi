import { isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from 'yaml'

// Readers for the two YAML shapes the action_runtime check looks at: a workflow (its steps'
// `uses:`) and an action's `action.yml` (`runs.using`, and the `uses:` of a composite's steps).

/** A `uses:` reference of a step. */
export interface ActionUse {
  /** As written, without quotes: `owner/repo/sub@ref`. */
  raw: string
  owner: string
  repo: string
  /** Folder of the action inside its repo, '' for the repo root. */
  subpath: string
  ref: string
  /** 1 based line of the `uses:` value in the file. */
  line: number | null
}

const REMOTE_USE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^@\s]+)?)@(\S+)$/

/** `owner/repo[/path]@ref`; null for a local (`./x`) or `docker://` use, or a ref that is an expression. */
export function parseUse(value: string, line: number | null = null): ActionUse | null {
  const raw = value.trim().replace(/^["']|["']$/g, '')
  const match = REMOTE_USE.exec(raw)
  if (!match || raw.includes('${{')) return null
  return {
    raw,
    owner: match[1]!,
    repo: match[2]!,
    subpath: (match[3] ?? '').replace(/^\//, ''),
    ref: match[4]!,
    line,
  }
}

function stepUses(steps: unknown, lines: LineCounter | null): ActionUse[] {
  if (!isSeq(steps)) return []
  return steps.items.flatMap((step) => {
    const node = isMap(step) ? step.get('uses', true) : null
    if (!isScalar(node) || typeof node.value !== 'string') return []
    const use = parseUse(node.value, node.range && lines ? lines.linePos(node.range[0]).line : null)
    return use ? [use] : []
  })
}

function rootOf(text: string): { root: YAMLMap | null; lines: LineCounter } {
  const lines = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lines, strict: false, uniqueKeys: false })
  return { root: isMap(doc.contents) ? doc.contents : null, lines }
}

/** Every remote step `uses:` of a workflow, with its line. Local (`./x`) and `docker://` uses are left out. */
export function parseWorkflowUses(text: string): ActionUse[] {
  const { root, lines } = rootOf(text)
  const jobs = root?.get('jobs', true)
  if (!isMap(jobs)) return []
  return jobs.items.flatMap((pair) => {
    const job = pair.value
    const steps = isMap(job) ? job.get('steps', true) : null
    return stepUses(steps, lines)
  })
}

export interface ActionManifest {
  /** `runs.using` as written (`node20`, `composite`, `docker`), null when absent. */
  using: string | null
  /** The remote `uses:` of a composite action's steps. */
  uses: ActionUse[]
}

/** `runs.using` and the nested uses of an `action.yml`; null when it is not a readable action. */
export function parseActionManifest(text: string): ActionManifest | null {
  const { root } = rootOf(text)
  const runs = root?.get('runs', true)
  if (!isMap(runs)) return null
  const using = runs.get('using', true)
  return {
    using: isScalar(using) && typeof using.value === 'string' ? using.value.trim() : null,
    uses: stepUses(runs.get('steps', true), null),
  }
}

const NODE_USING = /^node(\d+)$/i

/** The Node line of `runs.using` (`node20` gives `20`); null for `docker`, `composite` and the rest. */
export function nodeLineOfUsing(using: string): string | null {
  return NODE_USING.exec(using)?.[1] ?? null
}
