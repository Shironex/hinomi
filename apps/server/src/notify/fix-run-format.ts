import type { FixRunKind, FixRunState } from '@hinomi/shared'
import type { FixRunRow, RepoRow } from '../db/schema.js'
import { escapeHtml, type EmailContent } from './email.js'
import type { FixRunEventKey } from './fix-run-events.js'
import type { DiscordMessage } from './format.js'

/** One fix run event, flattened to what a message needs. Source of the Discord, JSON and email forms. */
export interface FixRunMessage {
  event: FixRunEventKey
  /** The headline: also the email subject and the Discord message text. */
  summary: string
  /** `owner/name`. */
  repo: string
  runId: number
  runKind: FixRunKind
  state: FixRunState
  plan: {
    scanRunId: number
    version: number
    /** Null until the runner's result was read. */
    steps: { applied: number; skipped: number; failed: number } | null
  }
  /** The fix PR, with its GitHub link. Null before it is opened. */
  pr: { number: number; url: string; draft: boolean } | null
  /** Why the PR is a draft, when it is. */
  draftReason: string | null
  /** Why a run failed or was lost. */
  reason: string | null
  /** Only on verified and not cleared: the findings the rescan compared. */
  counts: { targeted: number; cleared: number; stillOpen: number; new: number } | null
  /** Only on warning events: what Hinomi saw. */
  warnings: string[]
  /** Link to the run in Hinomi. Null on public repos and without a public base URL. */
  hinomiUrl: string | null
}

const REASON_MAX = 500

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Only http and https links go into a message. */
const safeLink = (url: string | null): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null

/**
 * The link back to the run in Hinomi. Like the fix PR body, only for private repos (the run's
 * checks mode is `install` there) with a public base URL: a message that lands in a shared
 * channel never shows the address of the instance for a public repo.
 */
export function hinomiRunUrl(run: FixRunRow, baseUrl: string | null): string | null {
  if (run.checksMode !== 'install' || !baseUrl) return null
  return `${baseUrl}/fix-runs?sel=${run.id}`
}

/** Why the runner left the PR as a draft, from its result. */
function draftReasonOf(run: FixRunRow): string | null {
  if (!run.prDraft) return null
  if (run.state === 'checks_failing') return 'the checks are failing'
  const result = run.result
  if (result?.install.status === 'failed') return 'the install failed'
  if (result?.checks.some((c) => c.status === 'failed' || c.status === 'timeout')) {
    return 'a check failed in the runner'
  }
  if (result?.steps.some((s) => s.status === 'failed')) return 'a step failed'
  return 'it was left as a draft'
}

function summaryOf(event: FixRunEventKey, repo: string, run: FixRunRow, draft: boolean): string {
  switch (event) {
    case 'pr_opened':
      return `Hinomi: ${draft ? 'draft fix PR' : 'fix PR'} opened for ${repo}`
    case 'checks_failing':
      return `Hinomi: checks are failing on the fix PR for ${repo}`
    case 'verified': {
      const cleared = run.verification?.cleared.length ?? 0
      return `Hinomi: fix verified for ${repo}, ${cleared} finding${cleared === 1 ? '' : 's'} cleared`
    }
    case 'not_cleared':
      return `Hinomi: the fix did not clear every finding for ${repo}`
    case 'failed':
      return `Hinomi: fix run ${run.state === 'lost' ? 'lost' : 'failed'} for ${repo}`
    default:
      return `Hinomi: the merged fix for ${repo} needs a look`
  }
}

export function fixRunMessage(
  event: FixRunEventKey,
  run: FixRunRow,
  repo: Pick<RepoRow, 'owner' | 'name'>,
  baseUrl: string | null,
): FixRunMessage {
  const name = `${repo.owner}/${repo.name}`
  const steps = run.result?.steps
  const verification = run.verification
  const showsCounts = event === 'verified' || event === 'not_cleared'
  const pr =
    run.prNumber !== null && safeLink(run.prUrl)
      ? { number: run.prNumber, url: run.prUrl as string, draft: run.prDraft }
      : null
  const code = event.startsWith('warning:') ? event.slice('warning:'.length) : null
  return {
    event,
    summary: summaryOf(event, name, run, run.prDraft),
    repo: name,
    runId: run.id,
    runKind: run.kind,
    state: run.state,
    plan: {
      scanRunId: run.planScanRunId,
      version: run.planVersion,
      steps: steps
        ? {
            applied: steps.filter((s) => s.status === 'applied').length,
            skipped: steps.filter((s) => s.status === 'skipped').length,
            failed: steps.filter((s) => s.status === 'failed').length,
          }
        : null,
    },
    pr,
    draftReason: event === 'pr_opened' || event === 'checks_failing' ? draftReasonOf(run) : null,
    reason: event === 'failed' && run.stateReason ? truncate(run.stateReason, REASON_MAX) : null,
    counts:
      showsCounts && verification
        ? {
            targeted: verification.targeted.length,
            cleared: verification.cleared.length,
            stillOpen: verification.stillOpen.length,
            new: verification.new.length,
          }
        : null,
    warnings: code
      ? run.warnings.filter((w) => w.code === code).map((w) => truncate(w.message, REASON_MAX))
      : [],
    hinomiUrl: hinomiRunUrl(run, baseUrl),
  }
}

/** Label and value rows shared by the Discord fields and both email bodies. */
export function fixRunRows(message: FixRunMessage): [string, string][] {
  const rows: [string, string][] = [['Repository', message.repo]]
  rows.push(['Fix run', `#${message.runId} (${message.runKind}, ${message.state})`])
  const { plan } = message
  const steps = plan.steps
    ? `, ${plan.steps.applied} applied, ${plan.steps.skipped} skipped, ${plan.steps.failed} failed`
    : ''
  rows.push(['Plan', `scan ${plan.scanRunId}, version ${plan.version}${steps}`])
  if (message.pr) {
    rows.push(['Pull request', `#${message.pr.number}${message.pr.draft ? ' (draft)' : ''}`])
  }
  if (message.draftReason) rows.push(['Draft because', message.draftReason])
  if (message.reason) rows.push(['Reason', message.reason])
  if (message.counts) {
    const c = message.counts
    rows.push([
      'Findings',
      `${c.targeted} targeted, ${c.cleared} cleared, ${c.stillOpen} still open, ${c.new} new`,
    ])
  }
  for (const warning of message.warnings) rows.push(['Warning', warning])
  return rows
}

/** The link a message opens: the PR on GitHub when there is one, else the run in Hinomi. */
function mainLink(message: FixRunMessage): string | null {
  return message.pr?.url ?? message.hinomiUrl
}

const COLORS: Record<string, number> = {
  pr_opened: 0x1d4ed8,
  checks_failing: 0xe8590c,
  verified: 0x2f9e44,
  not_cleared: 0xf0b429,
  failed: 0xb42318,
  warning: 0xf0b429,
}

export function fixRunDiscord(message: FixRunMessage): DiscordMessage {
  const color = COLORS[message.event.split(':')[0] ?? ''] ?? COLORS.warning
  const link = mainLink(message)
  const fields = fixRunRows(message).map(([name, value]) => ({
    name,
    value: truncate(value, 1024),
    inline: name !== 'Reason' && name !== 'Warning',
  }))
  if (message.pr && message.hinomiUrl) {
    fields.push({ name: 'In Hinomi', value: message.hinomiUrl, inline: false })
  }
  return {
    embeds: [
      {
        title: truncate(message.summary, 256),
        ...(link && { url: link }),
        color: color as number,
        fields,
      },
    ],
    allowed_mentions: { parse: [] },
  }
}

/** The body a generic webhook receives for a fix run event. Documented in docs/notifications.md. */
export interface FixRunWebhookPayload extends FixRunMessage {
  schema: 'hinomi.fix-run.v1'
  sentAt: string
}

export function fixRunWebhook(message: FixRunMessage, sentAt: Date): FixRunWebhookPayload {
  return { schema: 'hinomi.fix-run.v1', sentAt: sentAt.toISOString(), ...message }
}

export function fixRunEmail(message: FixRunMessage): EmailContent {
  const rows = fixRunRows(message)
  const links: [string, string][] = []
  if (message.pr) links.push(['Pull request link', message.pr.url])
  if (message.hinomiUrl) links.push(['In Hinomi', message.hinomiUrl])
  const text =
    [
      message.summary,
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      ...links.map(([k, v]) => `${k}: ${v}`),
    ].join('\n') + '\n'
  const row = (k: string, v: string) =>
    `<p style="margin:0;color:#374151"><span style="color:#6b7280">${escapeHtml(k)}:</span> ${escapeHtml(v)}</p>`
  const linkRow = (k: string, v: string) =>
    `<p style="margin:0;color:#374151"><span style="color:#6b7280">${escapeHtml(k)}:</span> <a href="${escapeHtml(v)}" style="color:#1d4ed8">${escapeHtml(v)}</a></p>`
  const html =
    `<!doctype html><html><body style="margin:0;padding:16px;font-family:system-ui,sans-serif;font-size:14px;color:#111827">` +
    `<h1 style="margin:0 0 16px;font-size:16px">${escapeHtml(message.summary)}</h1>` +
    rows.map(([k, v]) => row(k, v)).join('') +
    links.map(([k, v]) => linkRow(k, v)).join('') +
    `</body></html>`
  return { subject: message.summary.replace(/[\r\n]+/g, ' ').trim(), text, html }
}
