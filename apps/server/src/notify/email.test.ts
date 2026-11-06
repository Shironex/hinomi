import { createTransport } from 'nodemailer'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedEmail } from './channels.js'
import { createSmtpSender, emailContent, escapeHtml, SmtpError, transportOptions } from './email.js'
import { sampleItem } from './format.js'
import type { NotificationItem } from './items.js'

const config: ResolvedEmail = {
  host: 'smtp.example.dev',
  port: 587,
  security: 'starttls',
  user: 'hinomi@example.dev',
  password: 'smtp-SECRET-pass-0123',
  from: 'hinomi@example.dev',
  to: ['ops@example.dev'],
}
const silent = { info() {}, warn() {}, error() {} }

describe('emailContent', () => {
  it('escapes every piece of finding text and keeps remote content out', () => {
    const item: NotificationItem = {
      ...sampleItem('https://hinomi.example.dev'),
      title: '<script>alert(1)</script>',
      summary: '"><img src="https://tracker.example.dev/p.png">',
      repo: 'kestrel-co/<b>x</b>',
      url: 'https://hinomi.example.dev/finding/1?a="b"',
    }
    const { html, text } = emailContent('immediate', [item], 'Hinomi: 1 new item needs attention')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>x')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img')
    expect(html).toContain('href="https://hinomi.example.dev/finding/1?a=&quot;b&quot;"')
    expect(text).toContain('<script>alert(1)</script>')
  })

  it('drops links that are not http or https and says how many were left out', () => {
    const item = { ...sampleItem(null), url: 'javascript:alert(1)' }
    const { html, text } = emailContent('digest', [item], 'Hinomi daily digest: 31 changes', 1)
    expect(html).not.toContain('href')
    expect(html).not.toContain('javascript:')
    expect(text).not.toContain('Open:')
    expect(text).toContain('1 more not shown')
    expect(text).toContain('New: [HIGH] example-lib')
  })

  it('keeps the subject on one line', () => {
    expect(emailContent('test', [], 'a\r\nBcc: x@example.dev').subject).toBe('a Bcc: x@example.dev')
  })

  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })
})

describe('transportOptions', () => {
  it('maps the security modes', () => {
    expect(transportOptions({ ...config, security: 'tls' })).toMatchObject({
      secure: true,
      requireTLS: false,
    })
    expect(transportOptions(config)).toMatchObject({ secure: false, requireTLS: true })
    expect(transportOptions({ ...config, security: 'none' })).toMatchObject({
      secure: false,
      requireTLS: false,
    })
  })

  it('authenticates only with a user and a password', () => {
    expect(transportOptions(config).auth).toEqual({ user: config.user, pass: config.password })
    expect(transportOptions({ ...config, user: null, password: null })).not.toHaveProperty('auth')
  })
})

describe('createSmtpSender', () => {
  const message = {
    from: config.from,
    to: config.to,
    ...emailContent('test', [], 'Hinomi test message'),
  }

  it('hands the message to a nodemailer transport', async () => {
    const options: unknown[] = []
    const make = ((o: Parameters<typeof createTransport>[0]) => {
      options.push(o)
      return createTransport({ jsonTransport: true })
    }) as typeof createTransport
    const send = createSmtpSender({
      log: silent,
      sleep: () => Promise.resolve(),
      createTransport: make,
    })
    await send(config, message)
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ host: 'smtp.example.dev', port: 587, requireTLS: true })
  })

  function failing(error: Error, times: number) {
    let left = times
    const sendMail = vi.fn(() =>
      left-- > 0 ? Promise.reject(error) : Promise.resolve({ messageId: 'x' }),
    )
    const close = vi.fn()
    const make = (() => ({ sendMail, close })) as unknown as typeof createTransport
    return { sendMail, close, make }
  }

  it('retries a network error with backoff and closes every transport', async () => {
    const { sendMail, close, make } = failing(new Error('connect ETIMEDOUT'), 2)
    const sleeps: number[] = []
    const send = createSmtpSender({
      log: silent,
      sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
      createTransport: make,
    })
    await send(config, message)
    expect(sendMail).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([2000, 4000])
  })

  it('fails at once on a permanent reply and scrubs the password from the error', async () => {
    const error = Object.assign(new Error(`535 bad login for ${config.password}`), {
      responseCode: 535,
    })
    const { sendMail, make } = failing(error, 5)
    const send = createSmtpSender({
      log: silent,
      sleep: () => Promise.resolve(),
      createTransport: make,
    })
    const thrown = await send(config, message).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(SmtpError)
    expect((thrown as SmtpError).responseCode).toBe(535)
    expect((thrown as SmtpError).message).not.toContain(config.password as string)
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  it('gives up after the last attempt', async () => {
    const { sendMail, make } = failing(
      Object.assign(new Error('try later'), { responseCode: 421 }),
      9,
    )
    const send = createSmtpSender({
      log: silent,
      sleep: () => Promise.resolve(),
      createTransport: make,
      maxAttempts: 2,
    })
    await expect(send(config, message)).rejects.toThrow('try later')
    expect(sendMail).toHaveBeenCalledTimes(2)
  })
})
