import {
  LOCAL_RUNNER_WARNING,
  RUNNER_CALLBACK_PATH,
  RUNNER_CALLBACK_SCHEMA,
  currentTime,
  dispatchFixRunResponseSchema,
  runnerStatusSchema,
  webhookRunnerSettingsSchema,
} from '@hinomi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebhookApp } from '../app.js'
import { connectGithubToken, fakeGithub, repoReply, saveRunnerPlan } from '../runner/testing.js'
import { signRunnerPayload } from '../webhook/index.js'
import type { ApiOptions } from './register.js'
import { createTestApi } from './testing.js'

// Runner kinds per repo, the webhook runner settings, a webhook dispatch and its callback
// through the app. Every name and host is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')

function setup(options: { localRunner?: ApiOptions['localRunner'] } = {}) {
  const gh = fakeGithub([
    { path: '/repos/kestrel-co/harbor', reply: repoReply('Kestrel-Co', 'Harbor', 'private') },
    { path: '/user', reply: { body: { login: 'kestrel-bot' } } },
  ])
  const api = createTestApi({ sourceFetch: gh.fetch, ...options })
  const harbor = api.repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  connectGithubToken(api.repos)
  return { ...api, harbor }
}

let api: ReturnType<typeof setup>
afterEach(() => api.handle.close())

async function configureWebhookRunner(): Promise<string> {
  const rotated = await api.call('POST', '/settings/webhook-runner/secret')
  expect(rotated.status).toBe(201)
  const patched = await api.call('PATCH', '/settings/webhook-runner', {
    url: 'https://runner.example.dev/hinomi',
    callbackUrl: `https://hooks.example.dev${RUNNER_CALLBACK_PATH}`,
  })
  expect(patched.status).toBe(200)
  return (rotated.json as { secret: string }).secret
}

describe('webhook runner settings', () => {
  it('starts unconfigured and says what is missing', async () => {
    api = setup()
    const res = await api.call('GET', '/settings/webhook-runner')
    expect(res.status).toBe(200)
    expect(webhookRunnerSettingsSchema.parse(res.json)).toMatchObject({
      configured: false,
      url: null,
      secretSet: false,
      canStoreSecret: true,
      callbackPath: RUNNER_CALLBACK_PATH,
      message: 'Set the webhook runner URL.',
    })
  })

  it('refuses plain http and private addresses until they are allowed', async () => {
    api = setup()
    const http = await api.call('PATCH', '/settings/webhook-runner', {
      url: 'http://runner.example.dev/',
    })
    expect(http).toMatchObject({ status: 422, json: { error: { code: 'validation_failed' } } })
    const metadata = await api.call('PATCH', '/settings/webhook-runner', {
      url: 'https://169.254.169.254/latest',
    })
    expect(metadata.status).toBe(422)
    const allowed = await api.call('PATCH', '/settings/webhook-runner', {
      url: 'http://10.0.0.8:8080/run',
      allowPrivate: true,
    })
    expect(allowed.status).toBe(200)
    // Turning the switch off again with a private URL stored is refused too.
    const off = await api.call('PATCH', '/settings/webhook-runner', { allowPrivate: false })
    expect(off.status).toBe(422)
  })

  it('shows the secret once and never logs it', async () => {
    api = setup()
    const secret = await configureWebhookRunner()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const read = await api.call('GET', '/settings/webhook-runner')
    expect(read.text).not.toContain(secret)
    expect(read.json).toMatchObject({ configured: true, secretSet: true })
    expect(api.logger.text()).not.toContain(secret)
  })
})

describe('runner kind per repo', () => {
  it('starts on GitHub Actions and switches to the webhook runner', async () => {
    api = setup()
    const before = await api.call('GET', `/repos/${api.harbor.id}/runner`)
    const status = runnerStatusSchema.parse(before.json)
    expect(status.settings.kind).toBe('github_actions')
    expect(status.runners?.webhook.configured).toBe(false)

    const patched = await api.call('PATCH', `/repos/${api.harbor.id}/runner`, {
      kind: 'webhook',
      enabled: true,
    })
    expect(patched.status).toBe(200)
    const after = runnerStatusSchema.parse(patched.json)
    expect(after.settings.kind).toBe('webhook')
    expect(after.ready).toBe(false)
    expect(after.message).toBe('Set the webhook runner URL first.')

    await configureWebhookRunner()
    const ready = runnerStatusSchema.parse(
      (await api.call('GET', `/repos/${api.harbor.id}/runner`)).json,
    )
    expect(ready).toMatchObject({
      ready: true,
      message: 'Ready to dispatch to the webhook runner.',
    })
  })

  it('refuses the local kind while this host does not offer it', async () => {
    api = setup()
    const res = await api.call('PATCH', `/repos/${api.harbor.id}/runner`, { kind: 'local' })
    expect(res).toMatchObject({
      status: 409,
      json: {
        error: {
          code: 'conflict',
          message: expect.stringContaining('HINOMI_LOCAL_RUNNER=1') as string,
        },
      },
    })
    expect(api.repos.repos.get(api.harbor.id)?.runnerKind).toBe('github_actions')
    const status = runnerStatusSchema.parse(
      (await api.call('GET', `/repos/${api.harbor.id}/runner`)).json,
    )
    expect(status.runners?.local).toMatchObject({ available: false, warning: LOCAL_RUNNER_WARNING })
  })

  it('saves the local kind when this host offers it and reports it ready', async () => {
    api = setup({
      localRunner: {
        kind: 'local',
        availability: () => ({ available: true, message: 'The local runner is on.' }),
        dispatch: () => Promise.resolve({ created: false, code: 'busy', message: 'busy' }),
      },
    })
    const res = await api.call('PATCH', `/repos/${api.harbor.id}/runner`, {
      kind: 'local',
      enabled: true,
    })
    expect(res.status).toBe(200)
    const status = runnerStatusSchema.parse(
      (await api.call('GET', `/repos/${api.harbor.id}/runner`)).json,
    )
    expect(status).toMatchObject({
      ready: true,
      message: 'Ready to dispatch to the local runner.',
      settings: { kind: 'local' },
      runners: { local: { available: true, warning: LOCAL_RUNNER_WARNING } },
    })
  })
})

describe('webhook dispatch and callback', () => {
  it('refuses to dispatch while the webhook runner is not set up', async () => {
    api = setup()
    saveRunnerPlan(api.repos, api.harbor, T0)
    api.repos.repos.setRunner(api.harbor.id, { enabled: true, kind: 'webhook' })
    const res = await api.call('POST', `/repos/${api.harbor.id}/fix-runs`, {})
    expect(res).toMatchObject({ status: 409, json: { error: { code: 'conflict' } } })
    expect(api.runnerPosts).toHaveLength(0)
  })

  it('posts the plan, then a signed callback moves the run, on both listeners', async () => {
    api = setup()
    const secret = await configureWebhookRunner()
    saveRunnerPlan(api.repos, api.harbor, T0)
    api.repos.repos.setRunner(api.harbor.id, { enabled: true, kind: 'webhook' })

    const res = await api.call('POST', `/repos/${api.harbor.id}/fix-runs`, {})
    expect(res.status).toBe(201)
    const { run } = dispatchFixRunResponseSchema.parse(res.json)
    expect(run).toMatchObject({ runner: 'webhook', state: 'dispatched', github: null })
    expect(api.runnerPosts).toHaveLength(1)
    expect(JSON.parse(api.runnerPosts[0]?.body ?? '')).toMatchObject({
      runId: run.correlationId,
      repo: 'Kestrel-Co/Harbor',
      callbackUrl: `https://hooks.example.dev${RUNNER_CALLBACK_PATH}`,
    })

    const send = (
      app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
      status: string,
      delivery: string,
    ) => {
      const body = JSON.stringify({
        schema: RUNNER_CALLBACK_SCHEMA,
        runId: run.correlationId,
        status,
      })
      return app.request(RUNNER_CALLBACK_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hinomi-delivery': delivery,
          'x-hinomi-signature': signRunnerPayload(secret, body, currentTime()),
        },
        body,
      })
    }
    const queued = await send(api.app, 'queued', 'delivery-main-1')
    expect(queued.status).toBe(200)
    expect(await queued.json()).toEqual({ status: 'applied', state: 'queued' })

    const webhookOnly = createWebhookApp(api.githubWebhook, undefined, api.runnerCallback)
    const running = await send(webhookOnly, 'running', 'delivery-port-1')
    expect(await running.json()).toEqual({ status: 'applied', state: 'running' })
    expect(api.repos.fixRuns.get(run.id)?.state).toBe('running')
  })

  it('records a refused post as a failed run with the reason', async () => {
    api = setup()
    await configureWebhookRunner()
    saveRunnerPlan(api.repos, api.harbor, T0)
    api.repos.repos.setRunner(api.harbor.id, { enabled: true, kind: 'webhook' })
    api.runnerAnswer.status = 500
    const res = await api.call('POST', `/repos/${api.harbor.id}/fix-runs`, {})
    const { run } = dispatchFixRunResponseSchema.parse(res.json)
    expect(run.state).toBe('failed')
    expect(run.stateReason).toContain('HTTP 500')
  })
})
