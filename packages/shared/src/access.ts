import { z } from 'zod'

// How the current request reached Hinomi, from GET /api/access (see docs/access.md).
// Hinomi has no login, so this is what the UI shows instead of a generic warning.

export const ACCESS_STATES = ['tailscale', 'cloudflare_access', 'public', 'unknown'] as const
export const accessStateSchema = z.enum(ACCESS_STATES)
export type AccessState = z.infer<typeof accessStateSchema>

const base = {
  /**
   * The client address the state is based on: the socket peer, or the address a trusted
   * proxy (HINOMI_TRUSTED_PROXIES) forwarded. Null when the server cannot tell.
   */
  address: z.string().nullable(),
  /** True when `address` came from a forwarded header of a trusted proxy. */
  forwarded: z.boolean(),
}

export const accessStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('tailscale'),
    ...base,
    /** `address`: the client is in a Tailscale range. `serve`: `tailscale serve` identity headers. */
    via: z.enum(['address', 'serve']),
    /** Tailscale-User-Login, only when it came from `tailscale serve` or a trusted proxy. */
    login: z.string().nullable(),
  }),
  z.object({
    state: z.literal('cloudflare_access'),
    ...base,
    /** True when the Cf-Access-Jwt-Assertion token passed signature, issuer, audience and expiry checks. */
    verified: z.boolean(),
    /** Why the token was not verified: no team domain and audience set, or the certs could not be read. */
    unverifiedReason: z.enum(['not_configured', 'certs_unavailable']).nullable(),
    /** The email claim of a verified token. */
    email: z.string().nullable(),
  }),
  z.object({
    state: z.literal('public'),
    ...base,
    address: z.string(),
  }),
  z.object({
    state: z.literal('unknown'),
    ...base,
    /**
     * `private_address`: a LAN or container bridge address, for example a Docker port mapping
     * or a reverse proxy that is not trusted. `loopback`: a local process or proxy.
     * `no_address`: the server could not read the socket address.
     */
    reason: z.enum(['private_address', 'loopback', 'no_address']),
  }),
])
export type AccessStatus = z.infer<typeof accessStatusSchema>
