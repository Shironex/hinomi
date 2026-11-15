import { z } from 'zod'
import type { GuardCapability, GuardCheck } from '../guards.js'
import type { SourceKind } from '../model.js'
import {
  COOLIFY_FACTS,
  COOLIFY_GUARD_CAPABILITIES,
  deploymentFactsSchema,
  type FactKey,
} from './deployment-facts.js'

// The deployment source contract (docs/design/phase-2.md section 9, docs/sources.md): what every
// source of deployments returns and what it declares it can tell. The server's
// `DeploymentSource` interface (apps/server/src/sources/deployments) is built on these.

/**
 * Source kinds that report deployments. A subset of `SOURCE_KINDS`: a new deployment source adds
 * its kind to both, plus an entry in `DEPLOYMENT_SOURCE_CAPABILITIES`.
 */
export const DEPLOYMENT_SOURCE_KINDS = ['coolify'] as const satisfies readonly SourceKind[]
export const deploymentSourceKindSchema = z.enum(DEPLOYMENT_SOURCE_KINDS)
export type DeploymentSourceKind = z.infer<typeof deploymentSourceKindSchema>

export function isDeploymentSourceKind(kind: string): kind is DeploymentSourceKind {
  return (DEPLOYMENT_SOURCE_KINDS as readonly string[]).includes(kind)
}

export const deploymentKindSchema = z.enum(['application', 'service', 'database'])
export type DeploymentKind = z.infer<typeof deploymentKindSchema>

/**
 * One running thing on a deployment source, normalised so the join, the ranking and the guards
 * do not care which source reported it. Every deployment source returns these from `inventory()`.
 */
export const deploymentRecordSchema = z.object({
  /** Configured name of the source instance (for example "main"). */
  source: z.string().min(1),
  /** Stable id of the resource inside the source (the Coolify uuid), unique per source. */
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
  /**
   * Container configuration (see deployment-facts.ts). Left out when the source did not
   * read facts this time: the stored facts are then kept as they are.
   */
  facts: deploymentFactsSchema.nullable().optional(),
  /**
   * The source's change marker the facts were read at (Coolify: the resource's
   * `updated_at`). Facts are read again only when it moves. Null forces a read next time.
   */
  factsVersion: z.string().nullable().optional(),
})
export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>

/**
 * What a kind of deployment source can tell, declared once per kind. A source never claims more
 * than it reads: a guard whose fact the source lacks says `unknown`, never pass.
 */
export interface SourceCapabilities {
  /** Facts the source can report at all (per deployment, `facts.gaps` narrows it). */
  facts: ReadonlySet<FactKey>
  /** How much of each container check it can answer (`GET /api/guards`); a missing check is not answered. */
  guards: Partial<Record<GuardCheck, GuardCapability>>
  /** It reports domains, so reach comes from them. */
  domains: boolean
  /** It reports a run status, so stopped deployments rank lower. */
  status: boolean
}

export const COOLIFY_CAPABILITIES: SourceCapabilities = {
  facts: COOLIFY_FACTS,
  guards: COOLIFY_GUARD_CAPABILITIES,
  domains: true,
  status: true,
}

/** The capabilities of every deployment source kind. */
export const DEPLOYMENT_SOURCE_CAPABILITIES: Record<DeploymentSourceKind, SourceCapabilities> = {
  coolify: COOLIFY_CAPABILITIES,
}

/** What each deployment source kind answers for one container check (for a guard's registry entry). */
export function deploymentGuardCapabilities(
  check: GuardCheck,
): Partial<Record<DeploymentSourceKind, GuardCapability>> {
  const out: Partial<Record<DeploymentSourceKind, GuardCapability>> = {}
  for (const kind of DEPLOYMENT_SOURCE_KINDS) {
    const capability = DEPLOYMENT_SOURCE_CAPABILITIES[kind].guards[check]
    if (capability) out[kind] = capability
  }
  return out
}
