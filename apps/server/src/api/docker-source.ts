import {
  DOCKER_DEFAULT_SOCKET,
  readDockerSourceConfig,
  type DockerSourceConfig,
  type DockerSourceInput,
} from '@hinomi/shared'
import type { Source } from '../repository/index.js'
import { HttpError } from './http.js'

// The Docker source's fields in the sources API (docs/sources.md, docs/api.md): a socket path, or
// an https endpoint (`baseUrl`) with an optional CA and client certificate. The client key is the
// source's encrypted token. Plain http is refused (Q21).

function invalid(message: string): HttpError {
  return new HttpError(400, 'validation_failed', message)
}

/** What to store for a Docker source: the config, the endpoint and the key change, if any. */
export interface DockerFields {
  config: DockerSourceConfig
  baseUrl: string | null
  /** A new client key to store; null to remove the stored one; undefined to leave it. */
  key: string | null | undefined
}

/** Checks a Docker input against the endpoint and returns what to store. */
export function dockerFields(
  input: DockerSourceInput,
  baseUrl: string | null,
  current?: { config: DockerSourceConfig | null; hasKey: boolean },
): DockerFields {
  if (input.transport === 'socket') {
    if (baseUrl) throw invalid('A socket connection takes no URL')
    return {
      config: {
        transport: 'socket',
        socketPath: input.socketPath ?? DOCKER_DEFAULT_SOCKET,
        ca: null,
        cert: null,
        optIn: input.optIn ?? current?.config?.optIn ?? true,
      },
      baseUrl: null,
      // A socket uses no client key: drop one left from a TLS setup.
      key: current?.hasKey ? null : undefined,
    }
  }
  if (!baseUrl) throw invalid('A TLS connection needs the https URL of the Docker endpoint')
  if (!/^https:\/\//i.test(baseUrl)) {
    throw invalid(
      'Plain TCP without TLS is refused: Docker API access is root on the host. Use https, or a socket.',
    )
  }
  const previous = current?.config?.transport === 'tls' ? current.config : null
  const cert = input.cert === undefined ? (previous?.cert ?? null) : input.cert
  const ca = input.ca === undefined ? (previous?.ca ?? null) : input.ca
  const keyStored = input.key === undefined ? Boolean(current?.hasKey) : input.key !== null
  if (cert && !keyStored) throw invalid('A client certificate needs its private key')
  if (!cert && input.key) throw invalid('A private key needs its client certificate')
  return {
    config: {
      transport: 'tls',
      socketPath: null,
      ca,
      cert,
      optIn: input.optIn ?? previous?.optIn ?? true,
    },
    baseUrl,
    key: cert ? input.key : current?.hasKey ? null : undefined,
  }
}

/** The stored Docker config of a source, or null for other kinds. */
export function dockerConfigOf(source: Pick<Source, 'kind' | 'config'>): DockerSourceConfig | null {
  return source.kind === 'docker' ? readDockerSourceConfig(source.config) : null
}
