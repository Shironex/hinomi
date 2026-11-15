import http from 'node:http'
import https from 'node:https'
import { DockerError } from './errors.js'

// A small read only client for the Docker Engine API over a Unix socket (or a Windows named
// pipe) or an https endpoint, on `node:http` (docs/design/phase-2.md section 9.3). It can only
// send GET: Docker access is root on the host, so a write must be impossible by construction,
// not by convention. Paths are built by Hinomi, never taken from container data; redirects are
// never followed; every answer is capped in size and time.

export type DockerEndpoint =
  | { transport: 'socket'; socketPath: string }
  | {
      transport: 'tls'
      /** `https://host:port`, with an optional path prefix. */
      url: string
      ca?: string | null
      cert?: string | null
      key?: string | null
    }

export interface DockerTransportOptions {
  /** Whole request deadline, connection included. */
  timeoutMs?: number
  /** Largest answer read, in bytes; a larger one fails the request. */
  maxBytes?: number
}

export interface DockerResponse {
  status: number
  body: unknown
}

/** The only method the transport sends. Anything else is refused before a socket is opened. */
export const DOCKER_METHOD = 'GET'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

export interface DockerTransport {
  /**
   * GET `path` and parse the JSON answer. Throws `DockerError` for a network problem, a
   * timeout, an answer too large or not JSON, and any status but 2xx.
   */
  get(path: string): Promise<unknown>
  /** The request with a method check, for callers that name it. Only GET is allowed. */
  request(method: string, path: string): Promise<DockerResponse>
}

/** A path Hinomi built: absolute, no scheme or host, no dot segments, no control characters. */
function checkPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new DockerError('bad_request', 'A Docker API path must start with a single slash')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f\s]/.test(path) || /(^|\/)\.\.?(\/|$|\?)/.test(path.split('?')[0]!)) {
    throw new DockerError('bad_request', 'A Docker API path cannot hold spaces or dot segments')
  }
}

/** The https request options for a TLS endpoint: certificates are always verified. */
export function tlsRequestOptions(
  endpoint: Extract<DockerEndpoint, { transport: 'tls' }>,
  path: string,
): https.RequestOptions {
  let url: URL
  try {
    url = new URL(endpoint.url)
  } catch {
    throw new DockerError('bad_request', 'The Docker endpoint is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    throw new DockerError(
      'insecure',
      'Plain TCP without TLS is refused: Docker API access is root on the host. Use https with TLS, or a socket.',
    )
  }
  const prefix = url.pathname.replace(/\/+$/, '')
  return {
    protocol: 'https:',
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || 443,
    path: `${prefix}${path}`,
    method: DOCKER_METHOD,
    headers: { accept: 'application/json' },
    rejectUnauthorized: true,
    // No keep alive pool: a scan makes a handful of calls and the agent must not outlive it.
    agent: false,
    ...(endpoint.ca && { ca: endpoint.ca }),
    ...(endpoint.cert && { cert: endpoint.cert }),
    ...(endpoint.key && { key: endpoint.key }),
  }
}

function socketRequestOptions(socketPath: string, path: string): http.RequestOptions {
  return {
    socketPath,
    path,
    method: DOCKER_METHOD,
    // The daemon ignores the host, but HTTP/1.1 needs one.
    headers: { host: 'docker', accept: 'application/json' },
    agent: false,
  }
}

function networkError(error: NodeJS.ErrnoException): DockerError {
  const code = error.code ?? ''
  if (code === 'ENOENT') {
    return new DockerError('network', 'The Docker socket was not found at that path')
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DockerError(
      'network',
      'Hinomi may not open the Docker socket (check the group or the mount)',
    )
  }
  if (code === 'ECONNREFUSED')
    return new DockerError('network', 'The Docker endpoint refused the connection')
  if (
    code.startsWith('ERR_TLS') ||
    code.includes('CERT') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return new DockerError(
      'tls',
      'The TLS handshake with the Docker endpoint failed (check the CA and the client certificate)',
    )
  }
  return new DockerError('network', 'The Docker endpoint could not be reached')
}

export function createDockerTransport(
  endpoint: DockerEndpoint,
  options: DockerTransportOptions = {},
): DockerTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  async function request(method: string, path: string): Promise<DockerResponse> {
    // Hinomi never writes to a Docker host. Refuse before anything is opened.
    if (method !== DOCKER_METHOD) {
      throw new DockerError(
        'method_not_allowed',
        `Hinomi only sends GET to the Docker API, not ${method}`,
      )
    }
    checkPath(path)
    const requestOptions =
      endpoint.transport === 'socket'
        ? socketRequestOptions(endpoint.socketPath, path)
        : tlsRequestOptions(endpoint, path)
    const send = endpoint.transport === 'socket' ? http.request : https.request

    return new Promise<DockerResponse>((resolve, reject) => {
      let settled = false
      const finish = (error: DockerError | null, value?: DockerResponse) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          req.destroy()
          reject(error)
        } else resolve(value!)
      }
      const req = send(requestOptions, (res) => {
        const status = res.statusCode ?? 0
        const length = Number(res.headers['content-length'] ?? 0)
        if (length > maxBytes) {
          res.resume()
          return finish(
            new DockerError('too_large', `The Docker API answer for ${path} is too large`),
          )
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            res.destroy()
            finish(new DockerError('too_large', `The Docker API answer for ${path} is too large`))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', () =>
          finish(new DockerError('network', 'The Docker endpoint closed the connection')),
        )
        res.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          if (text.length > 0) {
            try {
              body = JSON.parse(text)
            } catch {
              body = text
            }
          }
          // `/_ping` answers `OK` as text, so a body that is not JSON stays a string.
          finish(null, { status, body })
        })
      })
      req.on('error', (error: NodeJS.ErrnoException) => finish(networkError(error)))
      const timer = setTimeout(
        () => finish(new DockerError('timeout', `The Docker API did not answer ${path} in time`)),
        timeoutMs,
      )
      req.end()
    })
  }

  return {
    request,
    async get(path) {
      const { status, body } = await request(DOCKER_METHOD, path)
      if (status >= 200 && status < 300) return body
      throw errorForStatus(status, path)
    },
  }
}

/** A non 2xx answer as an error. The daemon's message is not echoed: it can quote request data. */
export function errorForStatus(status: number, path: string): DockerError {
  const where = `The Docker API answered ${status} for ${path.split('?')[0]}`
  if (status === 401 || status === 403) {
    return new DockerError(
      'forbidden',
      `${where}: the endpoint refused it (a socket proxy must allow GET on containers)`,
      { status },
    )
  }
  if (status === 404) return new DockerError('not_found', `${where}: not found`, { status })
  if (status >= 300 && status < 400) {
    return new DockerError('http_error', `${where}: redirects are not followed`, { status })
  }
  if (status >= 500) return new DockerError('server_error', `${where}: daemon error`, { status })
  return new DockerError('http_error', where, { status })
}
