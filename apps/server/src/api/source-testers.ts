import type { SourceTestResult } from '@hinomi/shared'
import { testCoolifyConnection } from '../sources/coolify/index.js'
import {
  createGithubAppSource,
  createGithubSource,
  isGithubError,
} from '../sources/github/index.js'

export interface TestCoolifyInput {
  baseUrl: string
  token: string
}

export interface TestGithubInput {
  baseUrl: string | null
  token: string
}

export interface TestGithubAppInput {
  baseUrl: string | null
  appId: string
  installationId: string
  privateKey: string
}

/** Connection checks for the settings and onboarding screens. Never echo a secret. */
export interface SourceTesters {
  coolify(input: TestCoolifyInput): Promise<SourceTestResult>
  github(input: TestGithubInput): Promise<SourceTestResult>
  githubApp(input: TestGithubAppInput): Promise<SourceTestResult>
}

const PERMISSION_LABELS: Record<string, string> = {
  dependabot_alerts: 'Dependabot alerts',
  contents: 'Contents',
  metadata: 'Metadata',
}

function failure(error: unknown): SourceTestResult {
  if (isGithubError(error)) return { ok: false, code: error.kind, message: error.message }
  return { ok: false, code: 'network', message: 'Unexpected error while testing the connection' }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

const TEST_TIMEOUT_MS = 10_000

export function createSourceTesters(options: { fetch?: typeof fetch } = {}): SourceTesters {
  return {
    async coolify({ baseUrl, token }) {
      const result = await testCoolifyConnection({
        baseUrl,
        token,
        timeoutMs: TEST_TIMEOUT_MS,
        ...(options.fetch && { fetch: options.fetch }),
      })
      if (!result.ok) return result
      return {
        ok: true,
        message: result.version ? `Connected to Coolify ${result.version}` : 'Connected to Coolify',
        version: result.version,
      }
    },

    async github({ baseUrl, token }) {
      try {
        const source = createGithubSource({
          token,
          timeoutMs: TEST_TIMEOUT_MS,
          maxRetries: 0,
          maxWaitMs: 0,
          ...(baseUrl && { baseUrl }),
          ...(options.fetch && { fetch: options.fetch }),
        })
        const connection = await source.testConnection()
        return {
          ok: true,
          message: `Connected as ${connection.login}`,
          login: connection.login,
          scopes: connection.scopes,
        }
      } catch (error) {
        return failure(error)
      }
    },

    async githubApp({ baseUrl, appId, installationId, privateKey }) {
      try {
        const source = createGithubAppSource({
          appId,
          installationId,
          privateKey,
          timeoutMs: TEST_TIMEOUT_MS,
          maxRetries: 0,
          maxWaitMs: 0,
          ...(baseUrl && { baseUrl }),
          ...(options.fetch && { fetch: options.fetch }),
        })
        const connection = await source.testAppConnection()
        if (connection.missingPermissions.length > 0) {
          const names = connection.missingPermissions
            .map((name) => `${PERMISSION_LABELS[name] ?? name} (read)`)
            .join(', ')
          return {
            ok: false,
            code: 'permission',
            message: `The installation on ${connection.account} lacks ${names}. Add them to the app, then accept the new permissions on the installation`,
          }
        }
        const reach =
          connection.repositorySelection === 'all'
            ? `all ${plural(connection.repoCount, 'repo')}`
            : `${plural(connection.repoCount, 'selected repo')}`
        const hint = connection.canReadAlertSetting
          ? ''
          : '. Without Administration (read) Hinomi cannot tell whether Dependabot alerts are on'
        return {
          ok: true,
          message: `Connected to ${connection.account} with ${reach}${hint}`,
          login: connection.account,
          account: connection.account,
          repositorySelection: connection.repositorySelection,
          repoCount: connection.repoCount,
          missingPermissions: [],
        }
      } catch (error) {
        return failure(error)
      }
    },
  }
}
