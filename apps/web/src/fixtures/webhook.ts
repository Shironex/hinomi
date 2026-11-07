import type { GithubWebhookSettingsDto } from '@hinomi/shared'
import { ago } from './dataset'

/**
 * The GitHub webhook in the states the settings section shows. Pick one with
 * `?fixture=<name>` in fixture mode; every other scenario serves `webhook-on`.
 */
export const WEBHOOK_SCENARIOS = [
  'webhook-new',
  'webhook-off',
  'webhook-on',
  'webhook-error',
  'webhook-nokey',
] as const
export type WebhookScenario = (typeof WEBHOOK_SCENARIOS)[number]

export const isWebhookScenario = (value: string | null): value is WebhookScenario =>
  WEBHOOK_SCENARIOS.some((name) => name === value)

/** What generating a secret answers in fixture mode. Fictional, and not a real credential. */
export const WEBHOOK_SECRET = 'fixture-webhook-secret-7d1c4e9a52b8f063'

const base: GithubWebhookSettingsDto = {
  enabled: false,
  secretSet: false,
  secretCreatedAt: null,
  canStoreSecret: true,
  includePush: false,
  path: '/api/github/webhook',
  dedicatedPort: null,
  events: ['workflow_run', 'pull_request', 'check_suite', 'check_run', 'status', 'ping'],
  lastDeliveryAt: null,
  lastDeliveryEvent: null,
  lastErrorAt: null,
  lastError: null,
}

const SET = { secretSet: true, secretCreatedAt: ago(72) }
const ON = {
  ...SET,
  enabled: true,
  dedicatedPort: 3001,
  lastDeliveryAt: ago(0.1),
  lastDeliveryEvent: 'workflow_run',
}

export function webhookFor(scenario: string): GithubWebhookSettingsDto {
  switch (scenario) {
    case 'webhook-new':
      return base
    case 'webhook-off':
      return { ...base, ...SET }
    case 'webhook-error':
      return {
        ...base,
        ...ON,
        includePush: true,
        events: [...base.events, 'push'],
        lastDeliveryAt: ago(26),
        lastDeliveryEvent: 'pull_request',
        lastErrorAt: ago(0.4),
        lastError: 'A delivery was refused: its signature did not match the secret',
      }
    case 'webhook-nokey':
      return { ...base, canStoreSecret: false }
    default:
      return { ...base, ...ON }
  }
}
