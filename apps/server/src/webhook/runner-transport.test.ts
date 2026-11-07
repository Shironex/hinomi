import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../crypto/secret-box.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { createWebhookRunnerSettings, type WebhookRunnerSettings } from './runner-settings.js'
import {
  createWebhookRunnerTransport,
  nodeRunnerPoster,
  type RunnerDispatchPayload,
  type RunnerPostRequest,
  type RunnerPoster,
} from './runner-transport.js'
import { verifyRunnerSignature } from './signature.js'

// Posting plans to the webhook runner: signing, answers, the URL rules, and the real poster
// against a local server (no redirects, the connect time address guard). Hosts are fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')

const payload: RunnerDispatchPayload = {
  schema: 'hinomi.webhook-dispatch/1',
  runId: 'corr-1',
  kind: 'fix',
  repo: 'Kestrel-Co/Harbor',
  branch: 'hinomi/fix-plan',
  encoding: 'json',
  plan: '{"schema":"hinomi.fix-dispatch/1"}',
}

let handle: DatabaseHandle
let repos: Repositories
let settings: WebhookRunnerSettings
let secret: string

beforeEach(() => {
  const test = createTestRepositories()
  handle = test.handle
  repos = test.repos
  settings = createWebhookRunnerSettings(repos.settings, createSecretBox(TEST_SECRET))
  secret = settings.rotate(T0)
  settings.update({
    url: 'https://runner.example.dev/hinomi',
    callbackUrl: 'https://hooks.example.dev/api/runner/callback',
  })
})
afterEach(() => handle.close())

function recording(answer: Awaited<ReturnType<RunnerPoster>> | Error) {
  const sent: RunnerPostRequest[] = []
  const post: RunnerPoster = (request) => {
    sent.push(request)
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
  const transport = createWebhookRunnerTransport({
    settings,
    post,
    now: () => T0,
    deliveryId: () => 'delivery-0001',
  })
  return { transport, sent }
}

describe('webhook runner transport', () => {
  it('posts the plan with the callback URL, signed with the shared secret', async () => {
    const { transport, sent } = recording({ status: 202, body: '', location: null })
    expect(transport.problem()).toBeNull()
    expect(await transport.deliver(payload)).toEqual({ ok: true })

    const request = sent[0]
    expect(request?.url.href).toBe('https://runner.example.dev/hinomi')
    expect(request?.allowPrivate).toBe(false)
    expect(JSON.parse(request?.body ?? '')).toEqual({
      ...payload,
      callbackUrl: 'https://hooks.example.dev/api/runner/callback',
    })
    expect(request?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-hinomi-event': 'dispatch',
      'x-hinomi-delivery': 'delivery-0001',
    })
    const check = verifyRunnerSignature(
      secret,
      Buffer.from(request?.body ?? ''),
      request?.headers['x-hinomi-signature'],
      T0,
      300,
    )
    expect(check).toEqual({ ok: true })
  })

  it('reports a redirect, an error answer and a network failure as reasons', async () => {
    const redirect = recording({
      status: 302,
      body: '',
      location: 'https://elsewhere.example.dev/',
    })
    const redirected = await redirect.transport.deliver(payload)
    expect(!redirected.ok && redirected.reason).toContain('never follows redirects')
    const refused = recording({
      status: 503,
      body: `busy\u0000\n${'z'.repeat(400)}`,
      location: null,
    })
    const outcome = await refused.transport.deliver(payload)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('HTTP 503: busy z')
    expect(outcome.reason.length).toBeLessThan(320)
    const down = recording(new Error('connect ECONNREFUSED'))
    expect(await down.transport.deliver(payload)).toEqual({
      ok: false,
      reason: 'The webhook runner at runner.example.dev could not be reached: connect ECONNREFUSED',
    })
  })

  it('says what is missing before posting anything', async () => {
    const { transport, sent } = recording({ status: 200, body: '', location: null })
    settings.update({ url: 'http://runner.example.dev/' })
    expect(transport.problem()).toContain('https://')
    expect(await transport.deliver(payload)).toMatchObject({ ok: false })
    settings.update({ url: null })
    expect(transport.problem()).toBe('Set the webhook runner URL first.')
    expect(sent).toHaveLength(0)

    const noKey = createWebhookRunnerSettings(repos.settings, null)
    const withoutKey = createWebhookRunnerTransport({ settings: noKey })
    noKey.update({ url: 'https://runner.example.dev/' })
    expect(withoutKey.problem()).toContain('HINOMI_SECRET_KEY')
  })

  it('passes allowPrivate on, so the poster skips the address guard only then', async () => {
    const { transport, sent } = recording({ status: 200, body: '', location: null })
    settings.update({ url: 'http://10.0.0.8:8080/run', allowPrivate: true })
    expect(await transport.deliver(payload)).toEqual({ ok: true })
    expect(sent[0]?.allowPrivate).toBe(true)
  })
})

describe('nodeRunnerPoster', () => {
  let server: Server
  let hits: IncomingMessage[]
  let reply: (res: import('node:http').ServerResponse) => void
  let port: number

  beforeEach(async () => {
    hits = []
    reply = (res) => res.writeHead(200).end('ok')
    server = createServer((req, res) => {
      hits.push(req)
      req.resume()
      reply(res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const request = (url: string, allowPrivate: boolean, timeoutMs = 2000): RunnerPostRequest => ({
    url: new URL(url),
    body: '{}',
    headers: { 'content-type': 'application/json' },
    allowPrivate,
    timeoutMs,
  })

  it('refuses a name that resolves to a private address at connection time', async () => {
    await expect(nodeRunnerPoster(request(`http://localhost:${port}/`, false))).rejects.toThrow(
      /not a public address/,
    )
    expect(hits).toHaveLength(0)
  })

  it('posts when private addresses are allowed', async () => {
    const answer = await nodeRunnerPoster(request(`http://localhost:${port}/`, true))
    expect(answer).toMatchObject({ status: 200, body: 'ok' })
    expect(hits[0]?.method).toBe('POST')
  })

  it('never follows a redirect', async () => {
    reply = (res) => res.writeHead(307, { location: `http://127.0.0.1:${port}/other` }).end()
    const answer = await nodeRunnerPoster(request(`http://127.0.0.1:${port}/`, true))
    expect(answer).toMatchObject({ status: 307, location: `http://127.0.0.1:${port}/other` })
    expect(hits).toHaveLength(1)
  })

  it('keeps at most 4 KiB of the answer', async () => {
    reply = (res) => res.writeHead(500).end('e'.repeat(64 * 1024))
    const answer = await nodeRunnerPoster(request(`http://127.0.0.1:${port}/`, true))
    expect(answer.status).toBe(500)
    expect(answer.body.length).toBe(4096)
  })

  it('gives up after the timeout', async () => {
    reply = () => undefined
    await expect(nodeRunnerPoster(request(`http://127.0.0.1:${port}/`, true, 200))).rejects.toThrow(
      'no answer within 1 s',
    )
  })
})
