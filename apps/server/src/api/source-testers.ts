import { DOCKER_OPT_IN_LABEL, type DockerSourceConfig, type SourceTestResult } from '@hinomi/shared'
import { testCoolifyConnection } from '../sources/coolify/index.js'
import { testDokployConnection } from '../sources/dokploy/index.js'
import {
  createDockerTransport,
  dockerEndpointOf,
  isDockerError,
  testDockerConnection,
} from '../sources/docker/index.js'
import {
  createGithubAppSource,
  createGithubSource,
  isGithubError,
} from '../sources/github/index.js'

export interface TestCoolifyInput {
  baseUrl: string
  token: string
}

export interface TestDokployInput {
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

export interface TestDockerInput {
  config: DockerSourceConfig
  /** The https endpoint for a TLS connection, null for a socket. */
  baseUrl: string | null
  /** The client key, null when no client certificate is used. */
  key: string | null
}

/** Connection checks for the settings and onboarding screens. Never echo a secret. */
export interface SourceTesters {
  coolify(input: TestCoolifyInput): Promise<SourceTestResult>
  dokploy(input: TestDokployInput): Promise<SourceTestResult>
  docker(input: TestDockerInput): Promise<SourceTestResult>
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

    async dokploy({ baseUrl, token }) {
      const result = await testDokployConnection({
        baseUrl,
        token,
        timeoutMs: TEST_TIMEOUT_MS,
        ...(options.fetch && { fetch: options.fetch }),
      })
      if (!result.ok) return result
      const where = result.version ? `Dokploy ${result.version}` : 'Dokploy'
      return {
        ok: true,
        message: `Connected to ${where}, ${plural(result.projects, 'project')} visible`,
        version: result.version,
      }
    },

    async docker({ config, baseUrl, key }) {
      let transport
      try {
        transport = createDockerTransport(
          dockerEndpointOf(config, baseUrl, () => key),
          { timeoutMs: TEST_TIMEOUT_MS },
        )
      } catch (error) {
        if (isDockerError(error)) return { ok: false, code: error.code, message: error.message }
        throw error
      }
      const result = await testDockerConnection(transport, config.optIn)
      if (!result.ok) return result
      const what = config.optIn
        ? `${plural(result.containers, 'container')} labelled ${DOCKER_OPT_IN_LABEL}=true`
        : plural(result.containers, 'container')
      return {
        ok: true,
        message: `Connected to Docker${result.version ? ` ${result.version}` : ''}, ${what}`,
        version: result.version,
        ...(result.warning && { warning: result.warning }),
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
