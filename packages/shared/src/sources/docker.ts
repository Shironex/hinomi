import { z } from 'zod'

// The Docker host source (docs/design/phase-2.md section 9.3, Q21): how Hinomi reaches a Docker
// Engine API. A Unix socket (best through a GET only socket proxy) or an https endpoint with
// optional TLS client certificates; plain http is refused. The endpoint URL is the source's
// `baseUrl`, the client key its encrypted token, everything else lives in `sources.config`.

export const DOCKER_TRANSPORTS = ['socket', 'tls'] as const
export const dockerTransportSchema = z.enum(DOCKER_TRANSPORTS)
export type DockerTransport = z.infer<typeof dockerTransportSchema>

/** Where the Docker CLI looks by default; a socket proxy usually mounts its own path. */
export const DOCKER_DEFAULT_SOCKET = '/var/run/docker.sock'

/** Only containers with this label are read while `optIn` is on (the default). */
export const DOCKER_OPT_IN_LABEL = 'hinomi.enable'

/** An absolute Unix socket path, or a Windows named pipe (`\\.\pipe\docker_engine`). */
const socketPath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(
    /^(\/[^\0\s]*|\\\\\.\\pipe\\[^\0\s\\]+)$/,
    'Must be an absolute socket path, for example /var/run/docker.sock',
  )

const certificate = z
  .string()
  .trim()
  .max(16_000)
  .regex(
    /^(-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/,
    'Must be a PEM certificate (-----BEGIN CERTIFICATE-----)',
  )

const clientKey = z
  .string()
  .trim()
  .max(16_000)
  .regex(
    /^-----BEGIN ((RSA|EC) )?PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END ((RSA|EC) )?PRIVATE KEY-----$/,
    'Must be a PEM private key',
  )

/** What is stored in `sources.config` for a Docker source. No secret is in it. */
export const dockerSourceConfigSchema = z.object({
  transport: dockerTransportSchema,
  /** Socket transport: the socket path. Null for tls. */
  socketPath: socketPath.nullable(),
  /** TLS transport: the CA that signed the daemon's certificate, null to use the system CAs. */
  ca: certificate.nullable(),
  /** TLS transport: the client certificate, sent with the stored client key. */
  cert: certificate.nullable(),
  /** Read only containers labelled `hinomi.enable=true`. On by default. */
  optIn: z.boolean(),
})
export type DockerSourceConfig = z.infer<typeof dockerSourceConfigSchema>

/**
 * The Docker part of a create, update or test request. The client key is encrypted and stored
 * like a token; it is never sent back.
 */
export const dockerSourceInputSchema = z
  .strictObject({
    transport: dockerTransportSchema,
    socketPath: socketPath.optional(),
    ca: certificate.nullable().optional(),
    cert: certificate.nullable().optional(),
    /** TLS: the client key for `cert`. Omit to keep the stored one, null to remove it. */
    key: clientKey.nullable().optional(),
    optIn: z.boolean().optional(),
  })
  .refine((value) => value.transport !== 'socket' || value.socketPath !== undefined, {
    message: 'A socket connection needs the socket path',
    path: ['socketPath'],
  })
  .refine(
    (value) =>
      value.transport !== 'socket' || (value.ca == null && value.cert == null && value.key == null),
    { message: 'Certificates only apply to a TLS connection', path: ['transport'] },
  )
export type DockerSourceInput = z.infer<typeof dockerSourceInputSchema>

/** Reads a stored config, or null when it is missing or not a Docker config. */
export function readDockerSourceConfig(raw: unknown): DockerSourceConfig | null {
  const parsed = dockerSourceConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
