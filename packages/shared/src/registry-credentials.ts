import { z } from 'zod'

// Credentials for private images on OCI registries (ghcr.io, Docker Hub, any registry that speaks
// the distribution API), read by the registry SBOM image scan. One per registry host. The secret
// (a password, or a personal access token) is write only: the API says that one is set, never
// what it is.

/** Docker Hub's API host; `docker.io` and `index.docker.io` name the same registry. */
const DOCKER_HUB_API_HOST = 'registry-1.docker.io'
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', DOCKER_HUB_API_HOST])

/** A registry host with an optional port: no scheme, no path, no user info. */
const REGISTRY_HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9]\d{0,4})?$/

/**
 * The host a credential is stored and matched under: lower case, a scheme or trailing slash a
 * user pasted taken off, `:443` dropped (the API is always https), and Docker Hub's names folded
 * into its API host. Null when what is left is not a plain host.
 */
export function normalizeRegistryHost(raw: string): string | null {
  let host = raw.trim().toLowerCase()
  host = host.replace(/^https:\/\//, '').replace(/\/+$/, '')
  host = host.replace(/:443$/, '')
  if (!REGISTRY_HOST.test(host)) return null
  return DOCKER_HUB_ALIASES.has(host) ? DOCKER_HUB_API_HOST : host
}

const registryHost = z
  .string()
  .max(260)
  .transform((value, ctx) => {
    const host = normalizeRegistryHost(value)
    if (host === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be a registry host such as ghcr.io or registry.example.com:5000',
      })
      return z.NEVER
    }
    return host
  })

const registryUsername = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s:]+$/, 'Must be a user name without spaces or colons')
/** A password or an access token. Encrypted before it is stored; never sent back. */
const registrySecret = z.string().trim().min(1).max(4000)

/** A stored registry credential. The secret itself is never part of it. */
export const registryCredentialSchema = z.object({
  id: z.number().int().positive(),
  /** The registry host it is sent to, and only there (`ghcr.io`, `registry-1.docker.io`). */
  host: z.string(),
  username: z.string(),
  /** A secret is stored. */
  secretSet: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type RegistryCredentialDto = z.infer<typeof registryCredentialSchema>

export const registryCredentialsResponseSchema = z.object({
  items: z.array(registryCredentialSchema),
  /** False when HINOMI_SECRET_KEY is not set: credentials cannot be stored until it is. */
  canStoreSecrets: z.boolean(),
})
export type RegistryCredentialsResponse = z.infer<typeof registryCredentialsResponseSchema>

export const createRegistryCredentialRequestSchema = z.strictObject({
  host: registryHost,
  username: registryUsername,
  secret: registrySecret,
})
export type CreateRegistryCredentialRequest = z.input<typeof createRegistryCredentialRequestSchema>

/**
 * The host cannot change: a secret stays bound to the registry it was entered for. Remove the
 * credential and add it again for another host.
 */
export const updateRegistryCredentialRequestSchema = z
  .strictObject({
    username: registryUsername.optional(),
    /** A new secret replaces the stored one. */
    secret: registrySecret.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateRegistryCredentialRequest = z.input<typeof updateRegistryCredentialRequestSchema>
