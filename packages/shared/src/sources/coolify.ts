import { z } from 'zod'

export const deploymentKindSchema = z.enum(['application', 'service', 'database'])
export type DeploymentKind = z.infer<typeof deploymentKindSchema>

/** One running thing on a deployment source, normalised so later slices do not care where it came from. */
export const deploymentRecordSchema = z.object({
  /** Configured name of the source instance (for example "main"). */
  source: z.string().min(1),
  /** Stable id of the resource inside the source (the Coolify uuid). */
  externalId: z.string().min(1),
  name: z.string(),
  kind: deploymentKindSchema,
  /** Git repository as `owner/name`, or null when the resource has none (images, databases). */
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  /**
   * The git repository exactly as the source reports it, null when the
   * resource has no git source at all (services, registry images). Set even
   * when `repo` could not be parsed from it.
   */
  gitRepository: z.string().nullable().optional(),
  /** Domains as configured, with scheme, trimmed and deduplicated. */
  domains: z.array(z.string()),
  /** True when at least one domain is an http(s) URL. */
  isPublic: z.boolean(),
  server: z.string().nullable(),
  /** Raw status string of the source, for example "running:healthy". "unknown" when absent. */
  status: z.string(),
  image: z.string().nullable(),
  /** ISO timestamp of the last known deploy or change, null when the source does not say. */
  lastDeployAt: z.string().nullable(),
  /** Watch paths for monorepos, null when the source does not expose them. */
  watchPaths: z.array(z.string()).nullable(),
})
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>

export const coolifyConnectionConfigSchema = z.object({
  /** Name used as `source` on every record. */
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  token: z.string().min(1),
})
export type CoolifyConnectionConfig = z.infer<typeof coolifyConnectionConfigSchema>

export const coolifyErrorCodeSchema = z.enum([
  'invalid_config',
  'unauthorized',
  'forbidden',
  'not_found',
  'server_error',
  'http_error',
  'network',
  'timeout',
  'invalid_response',
])
export type CoolifyErrorCode = z.infer<typeof coolifyErrorCodeSchema>

export const coolifyConnectionTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), version: z.string().nullable() }),
  z.object({ ok: z.literal(false), code: coolifyErrorCodeSchema, message: z.string() }),
])
export type CoolifyConnectionTestResult = z.infer<typeof coolifyConnectionTestResultSchema>
