import type { FixPlan, FixPlanStep } from './api.js'
import { FixPayloadError, type FixAgentPreset, type FixResultV1 } from './runner.js'
import { cell, code, duration, fenced, plural, table } from './runner-markdown.js'
import { FIX_PR_BODY_MAX_CHARS, type FixPr, type FixPrBodyOptions } from './runner-pr.js'

// The majors PR: major upgrades a coding agent adapted the code to, on their own branch and
// always as a draft (decision 6 of the runner design). Rendered by Hinomi from the plan and the
// majors job's result, next to the fix PR's renderer.

/** Branch of the majors PR, one per repo, apart from the fix PR's. */
export const MAJORS_BRANCH = 'hinomi/majors'

/** What each preset is called in the PR body. */
const PRESET_LABELS: Record<FixAgentPreset, string> = {
  'claude-code': 'Claude Code',
  stub: 'the self test stub',
}

const OUTCOME_LABELS = {
  changed: 'changed files',
  no_changes: 'changed nothing',
  failed: 'failed',
  timeout: 'stopped at its time limit',
  refused: 'refused: its changes broke a limit of the majors patch',
} as const

function title(steps: FixPlanStep[]): string {
  const [first] = steps
  if (steps.length === 1 && first) {
    return `fix(deps): upgrade ${first.packageName} to ${first.to} with agent changes`
  }
  return `fix(deps): upgrade ${plural(steps.length, 'package')} across major versions with agent changes`
}

interface Context {
  plan: FixPlan
  result: FixResultV1
  options: FixPrBodyOptions
  handed: FixPlanStep[]
}

function preset(result: FixResultV1): string {
  return result.agent ? PRESET_LABELS[result.agent.preset] : 'a coding agent'
}

function summarySection({ plan, result, options, handed }: Context): string {
  const lines = [
    '> [!CAUTION]',
    `> An automated coding agent (${preset(result)}) wrote the changes in this pull request. Review every change carefully, including manifest scripts, before you mark it ready. It opens as a draft and Hinomi never merges it.`,
    '',
    `Hinomi handed ${plural(handed.length, 'major upgrade')} from the fix plan of scan ${plan.scanRunId} for ${code(plan.repo.fullName)} to the agent, with the instruction to keep the changes minimal and the tests passing.`,
  ]
  if (options.replaces !== undefined) {
    lines.push('', `Replaces #${options.replaces}, which was closed without merging.`)
  }
  if (options.linksAllowed && options.hinomiUrl) {
    lines.push('', `[Open this run in Hinomi](${options.hinomiUrl})`)
  }
  return lines.join('\n')
}

function upgradesSection({ result, handed }: Context): string {
  const status = new Map(result.steps.map((s) => [s.id, s]))
  const rows = handed.map((step) => [
    code(step.packageName),
    cell(step.from.join(', ')),
    cell(step.to),
    cell(step.lockfile ?? 'no lockfile'),
    status.get(step.id)?.status === 'applied' ? 'Yes' : 'No',
    step.advisories.map(code).join(', '),
  ])
  const head = ['Package', 'From', 'To', 'Lockfile', 'Lockfile changed', 'Advisories']
  return ['### Upgrades', '', table(head, rows)].join('\n')
}

function agentSection({ result }: Context): string | null {
  const { agent } = result
  if (!agent) return null
  const facts = [
    `Outcome: ${OUTCOME_LABELS[agent.outcome]}${agent.detail ? ` (${cell(agent.detail)})` : ''}.`,
    `Time: ${duration(agent.durationMs)}.`,
  ]
  if (agent.turns !== null) facts.push(`Turns: ${agent.turns}.`)
  if (agent.costUsd !== null) facts.push(`Estimated cost: ${agent.costUsd.toFixed(2)} USD.`)
  const parts = ['### Agent', '', facts.join(' ')]
  if (agent.summary) {
    parts.push(
      '',
      `<details><summary>The agent's closing notes</summary>\n\n${fenced(agent.summary)}\n</details>`,
    )
  }
  return parts.join('\n')
}

function filesSection({ result }: Context): string {
  const lines = ['### Files']
  if (result.patch) {
    const { files, insertions, deletions } = result.patch
    lines.push(
      '',
      `${plural(files.length, 'file')} changed, ${insertions} insertions, ${deletions} deletions.`,
    )
  }
  const refused = result.agent?.refusedPaths ?? []
  if (refused.length > 0) {
    lines.push(
      '',
      `Left out because the majors patch never carries them (workflows, hooks, tool configuration): ${refused.map(code).join(', ')}`,
    )
  }
  lines.push(
    '',
    "The runner did not run the checks after the agent; this repository's CI runs them on this pull request.",
  )
  return lines.join('\n')
}

function footer({ plan, result }: Pick<Context, 'plan' | 'result'>): string {
  return [
    '---',
    'Opened by Hinomi. Hinomi never merges; review and merge by hand.',
    `<!-- hinomi:majors repo=${plan.repo.id} plan=${plan.scanRunId} run=${result.runId} schema=1 -->`,
  ].join('\n')
}

/**
 * Renders the majors PR from the plan and the majors job's result: a factual note that an
 * automated agent made the changes, the upgrades it was handed (the result's steps), its
 * outcome and closing notes, and the files changed or refused. Always a draft. Throws
 * FixPayloadError `mismatch` when the result is for another plan or has no agent report.
 */
export function renderMajorsPrBody(
  plan: FixPlan,
  result: FixResultV1,
  options: FixPrBodyOptions,
): FixPr {
  if (result.planScanRunId !== plan.scanRunId || result.repo !== plan.repo.fullName) {
    throw new FixPayloadError('mismatch', 'The majors result belongs to another plan or repo')
  }
  if (!result.agent) {
    throw new FixPayloadError(
      'mismatch',
      'The result has no agent report, so it is not a majors run',
    )
  }
  const ids = new Set(result.steps.map((s) => s.id))
  const handed = plan.steps.filter((step) => ids.has(step.id)).sort((a, b) => a.order - b.order)
  const context: Context = { plan, result, options, handed }
  const sections = [
    summarySection(context),
    upgradesSection(context),
    agentSection(context),
    filesSection(context),
    footer(context),
  ]
  let body = sections.filter((s): s is string => s !== null).join('\n\n') + '\n'
  if (body.length > FIX_PR_BODY_MAX_CHARS) {
    const end = footer(context)
    body = `${body.slice(0, FIX_PR_BODY_MAX_CHARS - end.length - 40)}\n\nBody cut to fit.\n\n${end}\n`
  }
  return { title: title(handed), body, draft: true }
}
