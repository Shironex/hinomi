import { z } from 'zod'
import { GithubError } from './errors.js'

/** Raw GitHub payloads, trimmed to the fields Hinomi reads. */

export const restRepoSchema = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  archived: z.boolean(),
  fork: z.boolean().optional(),
  default_branch: z.string().nullable().optional(),
  visibility: z.string().optional(),
  private: z.boolean().optional(),
  pushed_at: z.string().nullable().optional(),
})
export type RestRepo = z.infer<typeof restRepoSchema>

export const restUserSchema = z.object({ login: z.string() })

export const graphqlAlertsSchema = z.object({
  repository: z
    .object({
      vulnerabilityAlerts: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z
            .object({
              number: z.number().int(),
              createdAt: z.string(),
              dismissedAt: z.string().nullable(),
              vulnerableManifestPath: z.string().nullable(),
              dependencyScope: z.string().nullable(),
              securityVulnerability: z.object({
                severity: z.string(),
                vulnerableVersionRange: z.string(),
                firstPatchedVersion: z.object({ identifier: z.string() }).nullable(),
                package: z.object({ name: z.string(), ecosystem: z.string() }),
                advisory: z.object({
                  ghsaId: z.string(),
                  summary: z.string(),
                  publishedAt: z.string().nullable(),
                  identifiers: z.array(z.object({ type: z.string(), value: z.string() })),
                  cvss: z
                    .object({ score: z.number().nullable(), vectorString: z.string().nullable() })
                    .nullable(),
                }),
              }),
            })
            .nullable(),
        ),
      }),
    })
    .nullable(),
})

export function parsePayload<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new GithubError('parse', `Unexpected GitHub ${what} payload: ${result.error.message}`, {
      cause: result.error,
    })
  }
  return result.data
}
