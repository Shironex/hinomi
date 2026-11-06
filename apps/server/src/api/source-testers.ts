import type { SourceTestResult } from '@hinomi/shared'
import { testCoolifyConnection } from '../sources/coolify/index.js'
import { createGithubSource, isGithubError } from '../sources/github/index.js'

export interface TestCoolifyInput {
  baseUrl: string
  token: string
}

export interface TestGithubInput {
  baseUrl: string | null
  token: string
}

/** Connection checks for the settings and onboarding screens. Never echo the token. */
export interface SourceTesters {
  coolify(input: TestCoolifyInput): Promise<SourceTestResult>
  github(input: TestGithubInput): Promise<SourceTestResult>
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
        if (isGithubError(error)) return { ok: false, code: error.kind, message: error.message }
        return {
          ok: false,
          code: 'network',
          message: 'Unexpected error while testing the connection',
        }
      }
    },
  }
}
