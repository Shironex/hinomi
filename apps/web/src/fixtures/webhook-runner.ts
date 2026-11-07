import type { WebhookRunnerSettingsDto } from '@hinomi/shared'
import { RUNNER_CALLBACK_PATH } from '@hinomi/shared'
import { ago } from './dataset'
import type { RunnerHost } from './fix-runs'

/**
 * The webhook runner settings and the runners the host offers, in the states the views show.
 * Pick one with `?fixture=<name>` in fixture mode; every other scenario serves `runner-on`.
 * `local-off` is the default instance on a host that does not offer the local runner.
 */
export const RUNNER_SCENARIOS = ['runner-new', 'runner-on', 'runner-error', 'local-off'] as const
export type RunnerScenario = (typeof RUNNER_SCENARIOS)[number]

export const isRunnerScenario = (value: string | null): value is RunnerScenario =>
  RUNNER_SCENARIOS.some((name) => name === value)

/** What generating a secret answers in fixture mode. Fictional, and not a real credential. */
export const RUNNER_SECRET = 'fixture-runner-secret-3b9e60d4c1a7f258'

const base: WebhookRunnerSettingsDto = {
  configured: false,
  url: null,
  allowPrivate: false,
  callbackUrl: null,
  secretSet: false,
  secretCreatedAt: null,
  canStoreSecret: true,
  callbackPath: RUNNER_CALLBACK_PATH,
  dedicatedPort: null,
  lastCallbackAt: null,
  lastErrorAt: null,
  lastError: null,
  message: 'Set the webhook runner URL and generate its secret first.',
}

const ON: WebhookRunnerSettingsDto = {
  ...base,
  configured: true,
  url: 'https://runner.example.dev/hinomi',
  callbackUrl: 'https://hooks.example.dev/api/runner/callback',
  secretSet: true,
  secretCreatedAt: ago(96),
  dedicatedPort: 3001,
  lastCallbackAt: ago(0.15),
  message: 'Ready to dispatch to the webhook runner.',
}

export function webhookRunnerFor(scenario: string): WebhookRunnerSettingsDto {
  switch (scenario) {
    case 'runner-new':
      return base
    case 'runner-error':
      return {
        ...ON,
        allowPrivate: true,
        lastCallbackAt: ago(5),
        lastErrorAt: ago(0.3),
        lastError: 'A callback was refused: its signature did not match the secret',
      }
    default:
      return ON
  }
}

/** The runners the host offers in a scenario, for the runner status of every repo. */
export const runnerHostFor = (scenario: string): RunnerHost => ({
  webhook: webhookRunnerFor(scenario).configured,
  local: scenario !== 'local-off',
})
