import {
  RUNNER_CALLBACK_MAX_BODY_BYTES,
  RUNNER_CALLBACK_PATH,
  RUNNER_CALLBACK_SCHEMA,
  webhookRunnerSettingsSchema,
  type RunnerCallback,
} from '@hinomi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecretBox } from '../crypto/secret-box.js'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories, TEST_SECRET } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import {
  createRunnerCallbackReceiver,
  type CallbackHandling,
  type CallbackRefused,
  type RunnerCallbackReceiver,
} from './runner-callback.js'
import { signRunnerPayload } from './signature.js'

// The callback receiver: what reaches the run handler and what never does. The handler is a
// fake here; the runner folder tests the mapping onto runs. Ids and hosts are fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const URL_ = `https://hooks.example.dev${RUNNER_CALLBACK_PATH}`

let handle: DatabaseHandle
let repos: Repositories
let receiver: RunnerCallbackReceiver
let handled: RunnerCallback[]
let answer: CallbackHandling
let secret: string
let now: Date
let deliveries: number

beforeEach(() => {
  const test = createTestRepositories()
  handle = test.handle
  repos = test.repos
  handled = []
  answer = { kind: 'applied', state: 'running' }
  now = T0
  deliveries = 0
  receiver = createRunnerCallbackReceiver({
    repositories: repos,
    secretBox: createSecretBox(TEST_SECRET),
    now: () => now,
    dedicatedPort: 3001,
    handle: (callback) => {
      handled.push(callback)
      return Promise.resolve(answer)
    },
  })
  secret = receiver.settings.rotate(T0)
})
afterEach(() => handle.close())

function body(fields: Partial<RunnerCallback> = {}): string {
  return JSON.stringify({
    schema: RUNNER_CALLBACK_SCHEMA,
    runId: 'corr-1',
    status: 'running',
    ...fields,
  })
}

function post(
  text: string,
  options: { signature?: string | null; delivery?: string; at?: Date; type?: string } = {},
): Promise<Response> {
  deliveries += 1
  const headers: Record<string, string> = {
    'content-type': options.type ?? 'application/json',
    'x-hinomi-delivery': options.delivery ?? `delivery-${String(deliveries).padStart(4, '0')}`,
  }
  const signature =
    options.signature === undefined
      ? signRunnerPayload(secret, text, options.at ?? now)
      : options.signature
  if (signature !== null) headers['x-hinomi-signature'] = signature
  return receiver.handle(new Request(URL_, { method: 'POST', headers, body: text }))
}

describe('runner callback receiver', () => {
  it('hands a signed callback to the run handler and answers with the run state', async () => {
    const response = await post(body())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'applied', state: 'running' })
    expect(handled).toEqual([
      { schema: RUNNER_CALLBACK_SCHEMA, runId: 'corr-1', status: 'running' },
    ])
    expect(receiver.view().lastCallbackAt).toBe(T0.toISOString())
  })

  it('answers 404 like an unknown route while no secret is set', async () => {
    const fresh = createTestRepositories()
    const closed = createRunnerCallbackReceiver({
      repositories: fresh.repos,
      secretBox: createSecretBox(TEST_SECRET),
      handle: () => Promise.resolve(answer),
    })
    const response = await closed.handle(
      new Request(URL_, {
        method: 'POST',
        body: body(),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(response.status).toBe(404)
    fresh.handle.close()
  })

  it('refuses a missing, wrong or stale signature before reading anything', async () => {
    expect((await post(body(), { signature: null })).status).toBe(401)
    expect((await post(body(), { signature: signRunnerPayload('other', body(), T0) })).status).toBe(
      401,
    )
    const stale = await post(body(), { at: new Date(T0.getTime() - 301_000) })
    expect(stale.status).toBe(401)
    expect(receiver.view().lastError).toContain('more than 5 minutes')
    expect(handled).toHaveLength(0)
  })

  it('refuses a body over the cap', async () => {
    const huge = body({ reason: 'x'.repeat(RUNNER_CALLBACK_MAX_BODY_BYTES) })
    const response = await post(huge)
    expect(response.status).toBe(413)
    expect(handled).toHaveLength(0)
  })

  it('refuses malformed callbacks after the signature checked out', async () => {
    expect((await post('{nope')).status).toBe(400)
    const unknown = await post(
      JSON.stringify({ schema: RUNNER_CALLBACK_SCHEMA, runId: 'corr-1', status: 'exploded' }),
    )
    expect(unknown.status).toBe(422)
    const extra = await post(body({ ...({ token: 'x' } as object) }))
    expect(extra.status).toBe(422)
    expect((await post(body(), { type: 'text/plain' })).status).toBe(415)
    expect((await post(body(), { delivery: 'x' })).status).toBe(400)
    expect(handled).toHaveLength(0)
  })

  it('answers a replayed delivery id as a duplicate without handling it again', async () => {
    const text = body()
    expect((await post(text, { delivery: 'delivery-same' })).status).toBe(200)
    const replay = await post(text, { delivery: 'delivery-same' })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ status: 'duplicate' })
    expect(handled).toHaveLength(1)
  })

  it('maps refusals to statuses and lets a refused delivery be sent again', async () => {
    const cases: Array<[CallbackRefused, number]> = [
      [{ kind: 'not_found', message: 'No webhook runner run has this id.' }, 404],
      [{ kind: 'invalid', message: 'bad result' }, 422],
      [{ kind: 'conflict', message: 'run is verified' }, 409],
      [{ kind: 'unavailable', message: 'GitHub is down' }, 503],
    ]
    for (const [refusal, status] of cases) {
      answer = refusal
      const response = await post(body(), { delivery: 'delivery-retry' })
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { message: refusal.message } })
    }
    answer = { kind: 'unchanged', state: 'running' }
    const retried = await post(body(), { delivery: 'delivery-retry' })
    expect(await retried.json()).toEqual({ status: 'unchanged', state: 'running' })
    expect(handled).toHaveLength(5)
  })

  it('shows the settings without the secret', () => {
    receiver.settings.update({ url: 'https://runner.example.dev/hinomi' })
    const view = webhookRunnerSettingsSchema.parse(receiver.view())
    expect(view).toMatchObject({
      configured: true,
      url: 'https://runner.example.dev/hinomi',
      secretSet: true,
      callbackPath: RUNNER_CALLBACK_PATH,
      dedicatedPort: 3001,
    })
    expect(JSON.stringify(view)).not.toContain(secret)
    receiver.settings.update({ url: 'https://10.0.0.8/run' })
    expect(receiver.view().configured).toBe(false)
    expect(receiver.view().message).toContain('not a public address')
  })
})
