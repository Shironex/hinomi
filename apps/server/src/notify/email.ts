import { createTransport, type Transporter } from 'nodemailer'
import type { ResolvedEmail } from './channels.js'
import { EVENT_LABELS, type MessageType } from './format.js'
import type { NotificationItem } from './items.js'
import type { ScanLogger } from '../scan/index.js'

/** What an email carries: a subject, plain text and a simple HTML body. */
export interface EmailContent {
  subject: string
  text: string
  html: string
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Only http and https links go into a message; anything else is left out. */
function safeLink(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null
}

/** Header values must stay on one line. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim()

/** The lines of one finding, shared by the text and HTML bodies. */
function itemLines(
  item: NotificationItem,
  labelEvent: boolean,
): { title: string; rows: [string, string][] } {
  const prefix = labelEvent || item.event === 'reopened' ? `${EVENT_LABELS[item.event]}: ` : ''
  const rows: [string, string][] = []
  if (item.summary) rows.push(['Summary', item.summary])
  if (item.repo) rows.push(['Repository', item.repo])
  if (item.deployments.length > 0) {
    rows.push(['Deployment', item.deployments.map((d) => `${d.name} (${d.reach})`).join(', ')])
  }
  if (item.installedVersion) rows.push(['Installed', item.installedVersion])
  if (item.fixedIn) rows.push(['Fixed in', item.fixedIn])
  if (item.sources.length > 0) rows.push(['Sources', item.sources.join(', ')])
  const ids = [item.advisory, ...item.cves].filter((id): id is string => id !== null)
  if (ids.length > 0) rows.push(['Advisory', ids.join(', ')])
  return { title: `${prefix}[${item.severity.toUpperCase()}] ${item.title}`, rows }
}

/**
 * Builds the email for a batch of items. No remote images, no scripts: a
 * heading, a line per field and a link back to Hinomi. Every piece of finding
 * text is HTML escaped.
 */
export function emailContent(
  type: MessageType,
  items: NotificationItem[],
  summary: string,
  omitted = 0,
  /** Lines under the heading (a summary's counts and link). */
  details: readonly string[] = [],
): EmailContent {
  const labelEvent = type === 'digest'
  const textBlocks: string[] = []
  const htmlBlocks: string[] = []
  for (const item of items) {
    const { title, rows } = itemLines(item, labelEvent)
    const link = safeLink(item.url)
    textBlocks.push(
      [title, ...rows.map(([k, v]) => `  ${k}: ${v}`), ...(link ? [`  Open: ${link}`] : [])].join(
        '\n',
      ),
    )
    const heading = link
      ? `<a href="${escapeHtml(link)}" style="color:#1d4ed8">${escapeHtml(title)}</a>`
      : escapeHtml(title)
    htmlBlocks.push(
      `<div style="margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid #e5e7eb">` +
        `<p style="margin:0 0 6px;font-weight:600">${heading}</p>` +
        rows
          .map(
            ([k, v]) =>
              `<p style="margin:0;color:#374151"><span style="color:#6b7280">${escapeHtml(k)}:</span> ${escapeHtml(v)}</p>`,
          )
          .join('') +
        `</div>`,
    )
  }
  const tail = omitted > 0 ? `${omitted} more not shown. Open Hinomi to see everything.` : ''
  const intro = details.length > 0 ? [...details, ''] : []
  const text =
    [summary, '', ...intro, ...textBlocks.map((b) => `${b}\n`), tail].join('\n').trimEnd() + '\n'
  const html =
    `<!doctype html><html><body style="margin:0;padding:16px;font-family:system-ui,sans-serif;font-size:14px;color:#111827">` +
    `<h1 style="margin:0 0 16px;font-size:16px">${escapeHtml(summary)}</h1>` +
    details.map((line) => `<p style="margin:0 0 6px">${escapeHtml(line)}</p>`).join('') +
    htmlBlocks.join('') +
    (tail ? `<p style="color:#6b7280">${escapeHtml(tail)}</p>` : '') +
    `</body></html>`
  return { subject: oneLine(summary), text, html }
}

export interface MailMessage extends EmailContent {
  from: string
  to: string[]
}

/** Sends one email through the given SMTP settings. Throws SmtpError. Replaced in tests. */
export type MailSender = (config: ResolvedEmail, message: MailMessage) => Promise<void>

/** Sending failed for good. The message never contains the SMTP password. */
export class SmtpError extends Error {
  override readonly name = 'SmtpError'
  constructor(
    message: string,
    /** SMTP reply code when the server answered; 5xx means permanent. */
    readonly responseCode: number | null,
  ) {
    super(message)
  }
}

export interface SmtpSenderOptions {
  log: ScanLogger
  sleep: (ms: number) => Promise<void>
  /** Tries in total, the first one included. Default 3. */
  maxAttempts?: number
  /** First backoff step. Doubles each retry. Default 2000 ms. */
  baseDelayMs?: number
  /** Replaced in tests to avoid a network connection. */
  createTransport?: typeof createTransport
}

const TIMEOUT_MS = 15_000

export function transportOptions(config: ResolvedEmail) {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ...(config.user !== null &&
      config.password !== null && { auth: { user: config.user, pass: config.password } }),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  }
}

function scrub(text: string, config: ResolvedEmail): string {
  let out = text
  if (config.password) out = out.split(config.password).join('[password]')
  return out
}

function toSmtpError(error: unknown, config: ResolvedEmail): SmtpError {
  const raw = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'responseCode' in error ? Number(error.responseCode) : NaN
  return new SmtpError(
    `Could not send the email: ${scrub(raw, config)}`,
    Number.isFinite(code) ? code : null,
  )
}

/**
 * The default sender: one nodemailer transport per message, closed after it.
 * Retries on network errors and 4xx replies; a 5xx reply (bad login,
 * rejected recipient) fails at once because trying again cannot help.
 */
export function createSmtpSender(options: SmtpSenderOptions): MailSender {
  const make = options.createTransport ?? createTransport
  const maxAttempts = options.maxAttempts ?? 3
  const base = options.baseDelayMs ?? 2000

  return async (config, message) => {
    for (let attempt = 1; ; attempt++) {
      const transport: Transporter = make(transportOptions(config))
      try {
        await transport.sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        })
        return
      } catch (error) {
        const failure = toSmtpError(error, config)
        const permanent = failure.responseCode !== null && failure.responseCode >= 500
        if (permanent || attempt >= maxAttempts) throw failure
        const wait = base * 2 ** (attempt - 1)
        options.log.warn('email delivery failed, retrying', {
          responseCode: failure.responseCode,
          attempt,
          waitMs: wait,
        })
        await options.sleep(wait)
      } finally {
        transport.close()
      }
    }
  }
}
