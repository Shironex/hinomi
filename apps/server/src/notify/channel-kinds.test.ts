import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../crypto/secret-box.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { verifyRunnerSignature } from '../webhook/signature.js'
import {
  fixRunPushText,
  gotifyMessage,
  ntfyMessage,
  scanPushText,
  slackFixRun,
  slackScan,
  telegramFixRun,
  telegramScan,
  type ScanBatch,
} from './chat-format.js'
import type { FixRunMessage } from './fix-run-format.js'
import { z } from 'zod'
import { NOTIFY_SETTING_KEYS, writePublicBaseUrl } from './settings.js'
import { sampleItem } from './format.js'
import type { NotificationItem } from './items.js'
import { createNotifier } from './notifier.js'

// Slack, ntfy, Gotify and Telegram channels, the signed generic webhook and the private address
// guard. Every host, token and chat here is fictional.

// Fake secrets, built from parts so no literal in the source looks like a real one.
const SLACK_URL = ['https://hooks.slack.com/services', 'Tfake', 'Bfake', 'SECRETslackPATH'].join(
  '/',
)
const NTFY_URL = 'https://ntfy.example.dev/hinomi-SECRET-topic'
const NTFY_TOKEN = ['tk', 'SECRETfakeNTFY'].join('_')
const GOTIFY_URL = 'https://gotify.example.dev/'
const GOTIFY_TOKEN = ['fake', 'SECRET', 'gotify'].join('-')
const BOT_TOKEN = ['42', `fake_SECRET_bot_${'x'.repeat(10)}`].join(':')
const HOOK_URL = 'https://hooks.example.dev/in/SECRET-PATH-0123456789'
const SIGNING_SECRET = ['SECRET', 'signing', 'fake'].join('-')
const CLOCK = new Date('2026-11-06T10:00:00Z')

interface Call {
  url: string
  via: 'fetch' | 'public'
  headers: Record<string, string>
  body: Record<string, unknown>
  raw: string
}

let repos: Repositories
let handle: DatabaseHandle
let calls: Call[]
let responses: Response[]
let logs: string[]

function recorder(via: Call['via']): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const raw = init?.body as string
    calls.push({
      url: String(url),
      via,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(raw) as Record<string, unknown>,
      raw,
    })
    return Promise.resolve(responses.shift() ?? new Response(null, { status: 204 }))
  }) as typeof fetch
}

beforeEach(() => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  calls = []
  responses = []
  logs = []
  writePublicBaseUrl(repos.settings, 'https://hinomi.example.dev')
})
afterEach(() => handle.close())

function notifier() {
  return createNotifier({
    repositories: repos,
    secretBox: createSecretBox(TEST_SECRET),
    fetch: recorder('fetch'),
    publicFetch: recorder('public'),
    now: () => CLOCK,
    sleep: () => Promise.resolve(),
    log: {
      info: (m) => logs.push(m),
      warn: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
      error: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
    },
  })
}

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return { ...sampleItem('https://hinomi.example.dev'), ...overrides }
}

describe('Slack', () => {
  it('accepts only incoming webhook URLs and masks them', () => {
    const n = notifier()
    expect(() => n.channels.add({ kind: 'slack', name: 's', url: HOOK_URL })).toThrow(/Slack/)
    expect(() =>
      n.channels.add({ kind: 'slack', name: 's', url: SLACK_URL, allowPrivate: true }),
    ).toThrow(/public service/)
    const channel = n.channels.add({ kind: 'slack', name: 's', url: SLACK_URL })
    expect(JSON.stringify(channel)).not.toContain('SECRET')
    expect(channel).toMatchObject({ kind: 'slack', urlEncrypted: true, allowPrivate: false })
    expect(channel.secretSet).toBeUndefined()
  })

  it('posts blocks with escaped text that can neither mention nor link', async () => {
    const n = notifier()
    const { id } = n.channels.add({ kind: 'slack', name: 's', url: SLACK_URL })
    expect(await n.sendTest(id)).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: SLACK_URL, via: 'public' })
    const body = calls[0]?.body as { text: string; blocks: { type: string }[] }
    expect(body.text).toBe('Hinomi test message')
    expect(body.blocks[0]).toMatchObject({ type: 'header' })
    expect(calls[0]?.raw).toContain('<https://hinomi.example.dev|[HIGH] example-lib>')
  })
})

describe('message text', () => {
  const batch = (items: NotificationItem[], type: ScanBatch['type'] = 'immediate'): ScanBatch => ({
    type,
    items,
    summary: 'Hinomi: 1 new item needs attention',
    omitted: 0,
    details: [],
    link: null,
  })

  it('escapes Slack control characters in finding text', () => {
    const raw = JSON.stringify(
      slackScan(batch([item({ summary: 'ping <!channel> & <https://evil.example.dev|click>' })])),
    )
    expect(raw).not.toContain('<!channel>')
    expect(raw).toContain('&lt;!channel&gt; &amp; &lt;https://evil.example.dev|click&gt;')
  })

  it('maps the most severe item to the push priority, digests stay default', () => {
    const critical = item({ severity: 'critical' })
    expect(scanPushText(batch([item(), critical])).urgency).toBe('max')
    expect(scanPushText(batch([item({ severity: 'low' })])).urgency).toBe('low')
    expect(scanPushText(batch([critical], 'digest')).urgency).toBe('default')
  })

  it('cuts a long push body at a line break and says so', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item({ findingId: i, summary: 'x'.repeat(300) }),
    )
    const text = scanPushText(batch(items, 'digest'))
    expect(text.body.length).toBeLessThanOrEqual(3500)
    expect(text.body).toMatch(/cut here\. Open Hinomi to see everything\.$/)
  })
})

describe('fix run messages', () => {
  const message: FixRunMessage = {
    event: 'failed',
    summary: 'Hinomi: fix run failed for kestrel-co/storefront',
    repo: 'kestrel-co/storefront',
    runId: 12,
    runKind: 'fix',
    state: 'failed',
    plan: { scanRunId: 7, version: 2, steps: null },
    pr: { number: 42, url: 'https://github.com/kestrel-co/storefront/pull/42', draft: false },
    draftReason: null,
    reason: 'the <runner> said no',
    counts: null,
    warnings: [],
    hinomiUrl: 'https://hinomi.example.dev/fix-runs?sel=12',
  }

  it('render the same rows and the PR link on every kind', () => {
    const push = fixRunPushText(message)
    expect(push).toMatchObject({
      title: message.summary,
      link: message.pr?.url,
      urgency: 'high',
    })
    expect(push.body).toContain('Reason: the <runner> said no')
    expect(ntfyMessage('t', push)).toMatchObject({ priority: 4, click: message.pr?.url })
    expect(gotifyMessage(push)).toMatchObject({ priority: 6 })
    const slack = JSON.stringify(slackFixRun(message))
    expect(slack).toContain('the &lt;runner&gt; said no')
    expect(slack).toContain('<https://hinomi.example.dev/fix-runs?sel=12|Open in Hinomi>')
    const telegram = telegramFixRun('-100123', message).text
    expect(telegram).toContain('the &lt;runner&gt; said no')
    expect(telegram).toContain(`<a href="${message.pr?.url}">Open the pull request</a>`)
  })
})

describe('ntfy', () => {
  it('needs a topic URL, keeps the token secret and posts JSON to the server root', async () => {
    const n = notifier()
    expect(() =>
      n.channels.add({ kind: 'ntfy', name: 'n', url: 'https://ntfy.example.dev/' }),
    ).toThrow(/topic/)
    const channel = n.channels.add({ kind: 'ntfy', name: 'n', url: NTFY_URL, secret: NTFY_TOKEN })
    expect(channel).toMatchObject({ secretSet: true, urlEncrypted: true })
    expect(JSON.stringify(n.channels.list())).not.toContain('SECRET')
    const stored = JSON.stringify(repos.settings.get(NOTIFY_SETTING_KEYS.channels, z.unknown()))
    expect(stored).not.toContain('SECRET')

    expect(await n.sendTest(channel.id)).toEqual({ ok: true })
    expect(calls[0]).toMatchObject({
      url: 'https://ntfy.example.dev/',
      headers: { authorization: `Bearer ${NTFY_TOKEN}` },
      body: {
        topic: 'hinomi-SECRET-topic',
        title: 'Hinomi test message',
        priority: 3,
        click: 'https://hinomi.example.dev',
      },
    })
    expect(calls[0]?.body.message).toContain('[HIGH] example-lib')
  })

  it('removes an optional token with an empty secret', () => {
    const n = notifier()
    const { id } = n.channels.add({ kind: 'ntfy', name: 'n', url: NTFY_URL, secret: NTFY_TOKEN })
    expect(n.channels.update(id, { secret: '' }).secretSet).toBe(false)
  })
})

describe('Gotify', () => {
  it('needs an app token and posts to /message with it in a header', async () => {
    const n = notifier()
    expect(() => n.channels.add({ kind: 'gotify', name: 'g', url: GOTIFY_URL })).toThrow(/token/)
    const { id } = n.channels.add({
      kind: 'gotify',
      name: 'g',
      url: GOTIFY_URL,
      secret: GOTIFY_TOKEN,
    })
    expect(() => n.channels.update(id, { secret: '' })).toThrow(/token is required/)
    expect(await n.sendTest(id)).toEqual({ ok: true })
    expect(calls[0]).toMatchObject({
      url: 'https://gotify.example.dev/message',
      headers: { 'x-gotify-key': GOTIFY_TOKEN },
      body: {
        title: 'Hinomi test message',
        priority: 4,
        extras: {
          'client::display': { contentType: 'text/plain' },
          'client::notification': { click: { url: 'https://hinomi.example.dev' } },
        },
      },
    })
  })
})

describe('Telegram', () => {
  it('needs a bot token and a chat, and never shows the token', () => {
    const n = notifier()
    expect(() =>
      n.channels.add({ kind: 'telegram', name: 't', secret: 'nope', chatId: '-100123' }),
    ).toThrow(/BotFather/)
    expect(() => n.channels.add({ kind: 'telegram', name: 't', secret: BOT_TOKEN })).toThrow(
      /chat id/,
    )
    const channel = n.channels.add({
      kind: 'telegram',
      name: 't',
      secret: BOT_TOKEN,
      chatId: '-1001234567890',
    })
    expect(channel).toMatchObject({
      url: 'Telegram chat -1001234567890',
      chatId: '-1001234567890',
      secretSet: true,
      urlEncrypted: true,
    })
    expect(JSON.stringify(channel)).not.toContain('SECRET')
  })

  it('sends HTML to the chat and waits for retry_after in parameters', async () => {
    const n = notifier()
    const { id } = n.channels.add({
      kind: 'telegram',
      name: 't',
      secret: BOT_TOKEN,
      chatId: '@kestrel_ops',
    })
    responses.push(
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 3 } },
        { status: 429 },
      ),
    )
    expect(await n.sendTest(id)).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
    expect(calls[0]?.body).toMatchObject({ chat_id: '@kestrel_ops', parse_mode: 'HTML' })
    expect(calls[0]?.body.text).toContain('<b>Hinomi test message</b>')
    expect(logs.join('\n')).toContain('"waitMs":3000')
  })

  it('never leaks the bot token in an error', async () => {
    const n = createNotifier({
      repositories: repos,
      secretBox: createSecretBox(TEST_SECRET),
      fetch: () => Promise.reject(new Error(`connect failed for bot${BOT_TOKEN}`)),
      sleep: () => Promise.resolve(),
      delivery: { maxAttempts: 1 },
      log: { info() {}, warn: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`), error() {} },
    })
    const { id } = n.channels.add({
      kind: 'telegram',
      name: 't',
      secret: BOT_TOKEN,
      chatId: '-100123',
    })
    const result = await n.sendTest(id)
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('SECRET')
    expect(logs.join('\n')).not.toContain('SECRET')
  })

  it('splits a long batch into messages under the limit, items never cut', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      item({ findingId: i + 1, summary: `${'Long summary <b>escaped</b> '.repeat(15)}${i}` }),
    )
    const batch: ScanBatch = {
      type: 'digest',
      items,
      summary: 'Hinomi daily digest: 30 changes',
      omitted: 4,
      details: [],
      link: null,
    }
    const messages = telegramScan('-100123', batch)
    expect(messages.length).toBeGreaterThan(1)
    expect(messages.reduce((sum, m) => sum + m.items, 0)).toBe(30)
    for (const { message } of messages) expect(message.text.length).toBeLessThanOrEqual(4096)
    expect(messages[0]?.message.text).toContain('<b>Hinomi daily digest: 30 changes</b>')
    expect(messages.at(-1)?.message.text).toContain('4 more not shown')
    expect(messages.map((m) => m.message.text).join('')).not.toContain('<b>escaped')
  })
})

describe('signed generic webhook', () => {
  it('signs the body with the secret in X-Hinomi-Signature', async () => {
    const n = notifier()
    const channel = n.channels.add({
      kind: 'webhook',
      name: 'w',
      url: HOOK_URL,
      secret: SIGNING_SECRET,
    })
    expect(channel.secretSet).toBe(true)
    expect(JSON.stringify(channel)).not.toContain('SECRET')
    await n.sendTest(channel.id)
    const call = calls[0]
    const header = call?.headers['x-hinomi-signature']
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(
      verifyRunnerSignature(SIGNING_SECRET, Buffer.from(call?.raw ?? ''), header, CLOCK, 300),
    ).toEqual({ ok: true })
  })

  it('sends no signature without a secret', async () => {
    const n = notifier()
    const { id } = n.channels.add({ kind: 'webhook', name: 'w', url: HOOK_URL })
    await n.sendTest(id)
    expect(calls[0]?.headers['x-hinomi-signature']).toBeUndefined()
  })
})

describe('private addresses', () => {
  const PRIVATE = [
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:8080/hook',
    'http://localhost/hook',
    'http://10.0.0.8/hook',
    'http://[::1]/hook',
    'http://[fd00::1]/hook',
  ]

  it.each(PRIVATE)('refuses %s unless the channel allows private addresses', (url) => {
    const n = notifier()
    expect(() => n.channels.add({ kind: 'webhook', name: 'w', url })).toThrow(/private/)
    expect(() => n.channels.add({ kind: 'ntfy', name: 'n', url: `${url}/topic` })).toThrow(
      /private/,
    )
    const allowed = n.channels.add({ kind: 'webhook', name: 'w', url, allowPrivate: true })
    expect(allowed.allowPrivate).toBe(true)
  })

  it('posts through the public only fetch unless private addresses are allowed', async () => {
    const n = notifier()
    const open = n.channels.add({ kind: 'webhook', name: 'w', url: HOOK_URL })
    const lan = n.channels.add({
      kind: 'gotify',
      name: 'g',
      url: 'http://gotify.lan:8080',
      secret: GOTIFY_TOKEN,
      allowPrivate: true,
    })
    await n.sendTest(open.id)
    await n.sendTest(lan.id)
    expect(calls.map((c) => c.via)).toEqual(['public', 'fetch'])
  })

  it('refuses to turn the setting off while the stored URL is private', () => {
    const n = notifier()
    const { id } = n.channels.add({
      kind: 'webhook',
      name: 'w',
      url: 'http://10.0.0.8/hook',
      allowPrivate: true,
    })
    expect(() => n.channels.update(id, { allowPrivate: false })).toThrow(/private/)
    expect(n.channels.update(id, { allowPrivate: false, url: HOOK_URL }).allowPrivate).toBe(false)
  })

  it('keeps a generic webhook stored before the setting able to reach private addresses', async () => {
    repos.settings.set(NOTIFY_SETTING_KEYS.channels, [
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'webhook',
        name: 'old',
        url: 'http://10.0.0.8/hook',
        urlEncrypted: false,
        enabled: true,
        minSeverity: 'low',
      },
    ])
    const n = notifier()
    expect(n.channels.list()[0]?.allowPrivate).toBe(true)
    expect(await n.sendTest('00000000-0000-4000-8000-000000000001')).toEqual({ ok: true })
    expect(calls[0]?.via).toBe('fetch')
  })
})

describe('refused addresses at connection time', () => {
  it('fails at once, without retrying or naming the address', async () => {
    let attempts = 0
    const n = createNotifier({
      repositories: repos,
      secretBox: createSecretBox(TEST_SECRET),
      publicFetch: () => {
        attempts++
        return Promise.reject(
          Object.assign(new Error('hooks.example.dev resolves to a private or reserved address'), {
            code: 'ENOTPUBLIC',
          }),
        )
      },
      sleep: () => Promise.resolve(),
    })
    const { id } = n.channels.add({ kind: 'webhook', name: 'w', url: HOOK_URL })
    const result = await n.sendTest(id)
    expect(attempts).toBe(1)
    expect(result).toEqual({
      ok: false,
      error:
        'Could not reach the webhook: hooks.example.dev resolves to a private or reserved address',
    })
  })
})

describe('header tokens', () => {
  it.each(['tok\nX-Injected: 1', 'two words', 'tök'])(
    'refuses an ntfy or Gotify token that is not one printable line: %j',
    (secret) => {
      const n = notifier()
      expect(() => n.channels.add({ kind: 'gotify', name: 'g', url: GOTIFY_URL, secret })).toThrow(
        /one line of printable/,
      )
      expect(() => n.channels.add({ kind: 'ntfy', name: 'n', url: NTFY_URL, secret })).toThrow(
        /one line of printable/,
      )
    },
  )
})
