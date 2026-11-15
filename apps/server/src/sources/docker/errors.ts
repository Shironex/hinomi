// Errors of the Docker host source. Messages are shown in the UI and stored as the source's last
// error: they never hold a key, a certificate or anything read from a container.

export type DockerErrorCode =
  | 'method_not_allowed'
  | 'bad_request'
  | 'insecure'
  | 'config'
  | 'network'
  | 'tls'
  | 'timeout'
  | 'too_large'
  | 'bad_response'
  | 'forbidden'
  | 'not_found'
  | 'server_error'
  | 'http_error'

export class DockerError extends Error {
  readonly code: DockerErrorCode
  readonly status?: number

  constructor(code: DockerErrorCode, message: string, options?: { status?: number }) {
    super(message)
    this.name = 'DockerError'
    this.code = code
    this.status = options?.status
  }
}

export function isDockerError(error: unknown): error is DockerError {
  return error instanceof DockerError
}
