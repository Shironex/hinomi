import {
  FINDING_TIERS,
  type FindingTier,
  type FixPlan,
  type FixPlanRiskReason,
  type FixPlanStep,
} from './api.js'
import {
  CHECK_OUTPUT_MAX_CHARS,
  FixPayloadError,
  type FixCheckResult,
  type FixResultStep,
  type FixResultV1,
  type FixStepReason,
} from './runner.js'

// The fix PR's title and body, rendered from the plan and the runner's result. Pure, so
// Hinomi (which opens the PR) and the runner render the same text.

/** Branch of the fix PR, one per repo. */
export const FIX_BRANCH = 'hinomi/fix-plan'
/** GitHub caps a PR body at 65,536 characters; the body stays under this. */
export const FIX_PR_BODY_MAX_CHARS = 60_000

export interface FixPrBodyOptions {
  /** The repo is private, so the body may link back to Hinomi. */
  linksAllowed: boolean
  /** The fix run's page in Hinomi, used only when links are allowed. */
  hinomiUrl?: string
  /**
   * The earlier fix PR this one replaces, after it was closed without merging and a person
   * asked for a fresh one (decision 10 of the runner design).
   */
  replaces?: number
}

export interface FixPr {
  title: string
  body: string
  /** Checks or the install failed, or a step failed: open as a draft. */
  draft: boolean
}

const TIER_LABELS: Record<FindingTier, string> = {
  blind_spot: 'Blind spot',
  exposed: 'Exposed',
  internal: 'Deployed, internal',
  public_low: 'Deployed, public, moderate or low',
  dev: 'Dev dependency',
  not_deployed: 'Not deployed',
  patched: 'Already patched',
  coverage: 'Coverage',
}

const REASON_LABELS: Record<FixStepReason, string> = {
  already_fixed: 'already fixed',
  no_longer_vulnerable: 'no longer vulnerable',
  too_new: 'too new for the release age gate',
  manual_specifier: 'specifier needs a person',
  not_in_lockfile: 'not in the lockfile',
  install_failed: 'install failed',
  edit_failed: 'manifest edit failed',
}

const RISK_LABELS: Record<FixPlanRiskReason, string> = {
  semver_major: 'Semver major',
  pins_other_versions: 'Override moves other versions',
  unknown_version: 'Versions are not semver',
  unknown_relationship: 'Direct or transitive unknown',
  unknown_package_manager: 'No lockfile Hinomi reads',
}

const CHANGE_LABELS: Record<FixPlanStep['apply']['type'], string> = {
  manifest_bump: 'bump',
  override: 'override',
  lockfile_update: 'cargo update',
  manual: 'manual',
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ')
}

function code(text: string): string {
  return `\`${cell(text).replace(/`/g, "'")}\``
}

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n')
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text}\n${fence}`
}

function sumTiers(steps: FixPlanStep[]): Map<FindingTier, number> {
  const totals = new Map<FindingTier, number>()
  for (const step of steps) {
    for (const tier of FINDING_TIERS) {
      const n = step.byTier[tier] ?? 0
      if (n > 0) totals.set(tier, (totals.get(tier) ?? 0) + n)
    }
  }
  return totals
}

function stepStatus(entry: FixResultStep | undefined, eligible?: string) {
  if (!entry) return 'Not sent: needs a person'
  if (entry.status === 'applied') return 'Applied'
  const verb = entry.status === 'failed' ? 'Failed' : 'Skipped'
  let reason = entry.reason ? REASON_LABELS[entry.reason] : 'no reason given'
  if (entry.reason === 'too_new' && eligible) reason += `, eligible on ${eligible.slice(0, 10)}`
  return cell(`${verb}: ${reason}${entry.detail ? ` (${entry.detail})` : ''}`)
}

function failedChecks(result: FixResultV1): FixCheckResult[] {
  const failed = result.checks.filter((c) => c.status === 'failed' || c.status === 'timeout')
  if (result.install.status !== 'failed') return failed
  const install: FixCheckResult = {
    name: 'install',
    command: `${result.packageManager} install`,
    status: 'failed',
    durationMs: result.install.durationMs,
    output: result.install.output,
    truncated: result.install.truncated,
  }
  return [install, ...failed]
}

function isDraft(result: FixResultV1): boolean {
  return failedChecks(result).length > 0 || result.steps.some((s) => s.status === 'failed')
}

function title(applied: FixPlanStep[]): string {
  if (applied.length === 0) return 'fix(deps): apply the hinomi fix plan'
  const findings = new Set(applied.flatMap((step) => step.findingIds)).size
  const packages = new Set(applied.map((step) => step.packageName)).size
  const exposed = sumTiers(applied).get('exposed') ?? 0
  const tail = exposed > 0 ? ` (${exposed} exposed)` : ''
  return `fix(deps): clear ${plural(findings, 'finding')} in ${plural(packages, 'package')}${tail}`
}

interface RenderContext {
  plan: FixPlan
  result: FixResultV1
  options: FixPrBodyOptions
  /** Characters of each failure tail to show. */
  tailChars: number
}

function summarySection({ plan, result, options }: RenderContext, applied: number): string {
  const safe = plan.steps.filter((s) => s.risk === 'safe').length
  const lines = [
    `Hinomi applied ${applied} of ${plural(safe, 'safe upgrade step')} from the fix plan of scan ${plan.scanRunId} for ${code(plan.repo.fullName)}.`,
  ]
  if (options.replaces !== undefined) {
    lines.push('', `Replaces #${options.replaces}, which was closed without merging.`)
  }
  if (options.linksAllowed && options.hinomiUrl) {
    lines.push('', `[Open this fix run in Hinomi](${options.hinomiUrl})`)
  }
  if (isDraft(result)) {
    lines.push(
      '',
      '> [!WARNING]',
      '> Something failed in the runner, so this pull request is a draft. See Failed checks below.',
    )
  }
  return lines.join('\n')
}

function clearedSection(applied: FixPlanStep[]): string | null {
  const totals = sumTiers(applied)
  if (totals.size === 0) return null
  const rows = FINDING_TIERS.filter((t) => totals.has(t)).map((t) => [
    TIER_LABELS[t],
    String(totals.get(t)),
  ])
  const advisories = [...new Set(applied.flatMap((step) => step.advisories))].sort()
  const parts = ['### Findings cleared', '', table(['Tier', 'Findings'], rows)]
  if (advisories.length > 0) parts.push('', `Advisories: ${advisories.map(code).join(', ')}`)
  return parts.join('\n')
}

function stepsSection({ plan, result }: RenderContext): string | null {
  const safe = plan.steps.filter((s) => s.risk === 'safe').sort((a, b) => a.order - b.order)
  if (safe.length === 0) return null
  const entries = new Map(result.steps.map((s) => [s.id, s]))
  const eligible = new Map(result.releaseAge.map((r) => [r.stepId, r.eligibleAt ?? undefined]))
  const rows = safe.map((step) => [
    String(step.order),
    code(step.packageName),
    cell(step.from.join(', ')),
    cell(step.to),
    CHANGE_LABELS[step.apply.type],
    cell(step.lockfile ?? 'no lockfile'),
    stepStatus(entries.get(step.id), eligible.get(step.id)),
  ])
  const head = ['#', 'Package', 'From', 'To', 'Change', 'Project', 'Result']
  return ['### Steps', '', table(head, rows)].join('\n')
}

function riskySection({ plan }: RenderContext): string | null {
  const risky = plan.steps.filter((s) => s.risk === 'risky').sort((a, b) => a.order - b.order)
  if (risky.length === 0) return null
  const rows = risky.map((step) => [
    code(step.packageName),
    cell(step.from.join(', ')),
    cell(step.to),
    cell(step.note ?? step.riskReasons.map((r) => RISK_LABELS[r]).join(', ')),
  ])
  return [
    '### Risky upgrades, not applied',
    '',
    'These need a person (or the optional majors job, which opens its own draft pull request).',
    '',
    table(['Package', 'From', 'To', 'Why'], rows),
  ].join('\n')
}

function unfixedSection({ plan }: RenderContext): string | null {
  if (plan.unfixed.length === 0) return null
  const rows = plan.unfixed.map((entry) => [
    code(entry.packageName),
    cell(entry.installed.join(', ')),
    entry.blocker === 'no_patch'
      ? 'No patched version yet'
      : cell(
          `Patched version too new${entry.availableAt ? `, available ${entry.availableAt.slice(0, 10)}` : ''}`,
        ),
    entry.advisories.map(code).join(', '),
  ])
  return ['### Unfixed', '', table(['Package', 'Installed', 'Why', 'Advisories'], rows)].join('\n')
}

function checksSection({ result }: RenderContext): string {
  if (result.checksMode === 'install' && result.checks.length === 0) {
    const install = result.install.status === 'ok' ? 'passed' : result.install.status
    return [
      '### Checks',
      '',
      `The runner only installed dependencies (install ${install}); this repository's CI runs the checks on this pull request.`,
    ].join('\n')
  }
  const rows = [
    [
      'install',
      '',
      result.install.status === 'ok' ? 'passed' : result.install.status,
      duration(result.install.durationMs),
    ],
    ...result.checks.map((c) => [cell(c.name), code(c.command), c.status, duration(c.durationMs)]),
  ]
  return ['### Checks', '', table(['Check', 'Command', 'Result', 'Duration'], rows)].join('\n')
}

function failuresSection({ result, tailChars }: RenderContext): string | null {
  const failed = failedChecks(result)
  if (failed.length === 0) return null
  const blocks = failed.map((c) => {
    const summary = `<summary>${cell(c.name)}: ${c.status}</summary>`
    if (tailChars === 0 || !c.output) return `<details>${summary}\n\nOutput left out.\n</details>`
    const tail = c.output.slice(-tailChars)
    const note =
      c.truncated || tail.length < c.output.length ? 'Last lines of the output:' : 'Output:'
    return `<details>${summary}\n\n${note}\n\n${fenced(tail)}\n</details>`
  })
  return ['### Failed checks', '', ...blocks].join('\n\n')
}

function footer({ plan, result }: RenderContext): string {
  return [
    '---',
    'Opened by Hinomi. Hinomi never merges; review and merge by hand.',
    `<!-- hinomi:fix repo=${plan.repo.id} plan=${plan.scanRunId} run=${result.runId} schema=1 -->`,
  ].join('\n')
}

function renderBody(context: RenderContext, applied: FixPlanStep[]): string {
  const sections = [
    summarySection(context, applied.length),
    clearedSection(applied),
    stepsSection(context),
    riskySection(context),
    unfixedSection(context),
    checksSection(context),
    failuresSection(context),
    footer(context),
  ]
  return sections.filter((s): s is string => s !== null).join('\n\n') + '\n'
}

/**
 * Renders the fix PR from the plan and the runner's result: title, findings cleared by tier,
 * the steps with their outcome, risky upgrades (always listed, never applied), unfixed
 * advisories, checks, and failure output when the PR is a draft. Links back to Hinomi only
 * when `linksAllowed`. Throws FixPayloadError `mismatch` when the result is for another plan.
 */
export function renderFixPrBody(
  plan: FixPlan,
  result: FixResultV1,
  options: FixPrBodyOptions,
): FixPr {
  if (result.planScanRunId !== plan.scanRunId || result.repo !== plan.repo.fullName) {
    throw new FixPayloadError('mismatch', 'The fix result belongs to another plan or repo')
  }
  const appliedIds = new Set(result.steps.filter((s) => s.status === 'applied').map((s) => s.id))
  const applied = plan.steps.filter((step) => appliedIds.has(step.id))
  let body = ''
  for (const tailChars of [CHECK_OUTPUT_MAX_CHARS, 1_000, 0]) {
    body = renderBody({ plan, result, options, tailChars }, applied)
    if (body.length <= FIX_PR_BODY_MAX_CHARS) break
  }
  if (body.length > FIX_PR_BODY_MAX_CHARS) {
    const end = footer({ plan, result, options, tailChars: 0 })
    body = `${body.slice(0, FIX_PR_BODY_MAX_CHARS - end.length - 40)}\n\nBody cut to fit.\n\n${end}\n`
  }
  return { title: title(applied), body, draft: isDraft(result) }
}
