import { GITHUB_WEBHOOK_PATH, accessStatusSchema } from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebhookApp } from '../app.js'
import { signGithubPayload } from '../webhook/index.js'
import { MAX_BODY_BYTES } from './register.js'
import { createTestApi } from './testing.js'

// The webhook settings API, where the receiver is mounted, and the webhook only listener.
// Every org, repo and address here is fictional.

const PUBLIC = '203.0.113.9'

let api: ReturnType<typeof createTestApi>
beforeEach(() => {
  api = createTestApi()
})
afterEach(() => api.handle.close())

/** A request as the Node server sees it, from `remoteAddress`. */
function fromPeer(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress, remotePort: 51234, remoteFamily: 'IPv4' } } }
}

function delivery(secret: string, body: string, id = '72d3162e-cc78-11e3-81ab-4c9367dc0958') {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-github-delivery': id,
      'x-hub-signature-256': signGithubPayload(secret, body),
    },
    body,
  }
}

async function enable(): Promise<string> {
  const rotated = await api.call('POST', '/settings/github-webhook/secret')
  expect(rotated.status).toBe(201)
  const { secret } = rotated.json as { secret: string }
  expect((await api.call('PATCH', '/settings/github-webhook', { enabled: true })).status).toBe(200)
  return secret
}

describe('webhook settings', () => {
  it('starts off, without a secret, with the events to tick', async () => {
    const res = await api.call('GET', '/settings/github-webhook')
    expect(res).toMatchObject({
      status: 200,
      json: {
        enabled: false,
        secretSet: false,
        canStoreSecret: true,
        includePush: false,
        path: GITHUB_WEBHOOK_PATH,
        dedicatedPort: null,
        events: ['workflow_run', 'pull_request', 'check_suite', 'check_run', 'status', 'ping'],
        lastDeliveryAt: null,
      },
    })
  })

  it('refuses to turn on before a secret exists', async () => {
    const res = await api.call('PATCH', '/settings/github-webhook', { enabled: true })
    expect(res).toMatchObject({ status: 409, json: { error: { code: 'conflict' } } })
  })

  it('shows a new secret once, then only that one is set', async () => {
    const first = await api.call('POST', '/settings/github-webhook/secret')
    const { secret, settings } = first.json as { secret: string; settings: { secretSet: boolean } }
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(settings.secretSet).toBe(true)
    const read = await api.call('GET', '/settings/github-webhook')
    expect(read.text).not.toContain(secret)
    const second = await api.call('POST', '/settings/github-webhook/secret')
    expect((second.json as { secret: string }).secret).not.toBe(secret)
    expect(api.logger.text()).not.toContain(secret)
  })

  it('turns push on and the webhook off', async () => {
    await enable()
    const res = await api.call('PATCH', '/settings/github-webhook', {
      includePush: true,
      enabled: false,
    })
    expect(res.json).toMatchObject({ enabled: false, includePush: true })
    expect((res.json as { events: string[] }).events).toContain('push')
    expect((await api.call('PATCH', '/settings/github-webhook', {})).status).toBe(400)
  })

  it('needs HINOMI_SECRET_KEY to make a secret', async () => {
    const keyless = createTestApi({ withSecret: false })
    try {
      const res = await keyless.call('POST', '/settings/github-webhook/secret')
      expect(res).toMatchObject({ status: 400, json: { error: { code: 'secret_key_missing' } } })
      expect((await keyless.call('GET', '/settings/github-webhook')).json).toMatchObject({
        canStoreSecret: false,
      })
    } finally {
      keyless.handle.close()
    }
  })
})

describe('the receiver on the main port', () => {
  it('is a plain unknown route while off', async () => {
    const res = await api.app.request(GITHUB_WEBHOOK_PATH, delivery('anything', '{}'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'No such API route' },
    })
  })

  it('accepts deliveries larger than the API body limit, which still holds elsewhere', async () => {
    const secret = await enable()
    const body = JSON.stringify({ zen: 'x'.repeat(MAX_BODY_BYTES * 2) })
    const res = await api.app.request(GITHUB_WEBHOOK_PATH, delivery(secret, body))
    expect(res.status).toBe(202)
    const elsewhere = await api.call('PATCH', '/settings', body)
    expect(elsewhere.status).toBe(413)
  })

  it('takes a delivery from a public address without the access checks', async () => {
    const secret = await enable()
    const res = await api.app.request(GITHUB_WEBHOOK_PATH, delivery(secret, '{}'), fromPeer(PUBLIC))
    expect(res.status).toBe(202)
    // The access status of a public client is unchanged by the webhook being on.
    const access = await api.app.request('/api/access', {}, fromPeer(PUBLIC))
    expect(accessStatusSchema.parse(await access.json()).state).toBe('public')
  })

  it('answers only POST', async () => {
    await enable()
    expect((await api.app.request(GITHUB_WEBHOOK_PATH)).status).toBe(404)
  })
})

describe('the webhook only listener', () => {
  it('serves the webhook path and nothing else', async () => {
    const secret = await enable()
    const app = createWebhookApp(api.githubWebhook)
    const ok = await app.request(GITHUB_WEBHOOK_PATH, delivery(secret, '{}'), fromPeer(PUBLIC))
    expect(ok.status).toBe(202)
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/index.html'],
      ['GET', '/api/health'],
      ['GET', '/api/access'],
      ['GET', '/api/settings'],
      ['GET', '/api/settings/github-webhook'],
      ['POST', '/api/settings/github-webhook/secret'],
      ['GET', '/api/fix-runs'],
      ['POST', '/api/scans'],
      ['GET', GITHUB_WEBHOOK_PATH],
      ['POST', `${GITHUB_WEBHOOK_PATH}/extra`],
      ['POST', '/api/github/../settings/github-webhook/secret'],
    ] as const) {
      const res = await app.request(path, { method }, fromPeer(PUBLIC))
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    // The secret was not rotated by any of those.
    const again = await app.request(
      GITHUB_WEBHOOK_PATH,
      delivery(secret, '{}', '72d3162e-cc78-11e3-81ab-4c9367dc0959'),
    )
    expect(again.status).toBe(202)
  })

  it('rejects an unsigned request with 401 and no detail', async () => {
    await enable()
    const app = createWebhookApp(api.githubWebhook)
    const res = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })
})
