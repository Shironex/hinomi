import { parseDocument } from 'yaml'
import { z } from 'zod'
import { repoFullNameSchema } from '../api.js'
import { deploymentReachSchema, type DeploymentReach } from '../model.js'

// Manual deployment entries (docs/design/phase-2.md section 9.5): the shape typed in the web
// form, sent to the API and written in a YAML file, with the YAML reader.

/** Entries one YAML import may hold, and the size of the file. */
export const MANUAL_IMPORT_MAX_ENTRIES = 500
export const MANUAL_IMPORT_MAX_BYTES = 48 * 1024

/** Entries one manual list may hold. */
export const MANUAL_MAX_ENTRIES = 1000

const trimmed = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null))

/** A domain as typed: a host or an http(s) URL, no spaces. */
const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(https?:\/\/)?[^\s/?#]+[^\s]*$/i, 'Must be a host name or an http(s) URL')
  .transform((value) => value.replace(/\/+$/, ''))

/** True when a domain is an http(s) URL, which is what makes a deployment public by default. */
export const isHttpDomain = (domain: string): boolean => /^https?:\/\/[^/\s]+/i.test(domain)

/** The reach to use when the entry names none: a public URL means public, otherwise unknown (never hidden). */
export function defaultReach(domains: readonly string[]): DeploymentReach {
  return domains.some(isHttpDomain) ? 'public' : 'unknown'
}

const manualFields = {
  name: trimmed(100),
  /** The repo it was built from, as `owner/name`. Without one the entry is image only. */
  repo: repoFullNameSchema.nullable().optional(),
  branch: optionalText(255),
  image: optionalText(300),
  domains: z
    .array(domainSchema)
    .max(50)
    .optional()
    .transform((list) => [...new Set(list ?? [])]),
  /** public, internal or unknown. Omitted: public with an http(s) domain, else unknown. */
  reach: deploymentReachSchema.optional(),
  server: optionalText(100),
}

/** One manual entry as typed in the form or written in YAML. */
export const manualEntrySchema = z.strictObject(manualFields)
export type ManualEntryInput = z.input<typeof manualEntrySchema>

/** A manual entry with every default filled in, as stored. */
export interface ManualEntry {
  name: string
  repo: string | null
  branch: string | null
  image: string | null
  domains: string[]
  reach: DeploymentReach
  server: string | null
}

/** Fills the defaults of a parsed entry: nulls for the optional text, the reach from the domains. */
export function completeManualEntry(entry: z.output<typeof manualEntrySchema>): ManualEntry {
  return {
    name: entry.name,
    repo: entry.repo ?? null,
    branch: entry.branch,
    image: entry.image,
    domains: entry.domains,
    reach: entry.reach ?? defaultReach(entry.domains),
    server: entry.server,
  }
}

/** POST /api/deployments: one entry for a manual source. */
export const createManualDeploymentRequestSchema = z.strictObject({
  sourceId: z.number().int().positive(),
  ...manualFields,
})
export type CreateManualDeploymentRequest = z.input<typeof createManualDeploymentRequestSchema>

/** PATCH /api/deployments/:id: the fields to change. `null` clears an optional one. */
export const updateManualDeploymentRequestSchema = z
  .strictObject({
    name: manualFields.name.optional(),
    repo: manualFields.repo,
    branch: z.string().trim().max(255).nullable().optional(),
    image: z.string().trim().max(300).nullable().optional(),
    domains: z.array(domainSchema).max(50).optional(),
    reach: deploymentReachSchema.optional(),
    server: z.string().trim().max(100).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type UpdateManualDeploymentRequest = z.input<typeof updateManualDeploymentRequestSchema>

/** POST /api/deployments/import: a YAML file of entries for a manual source. */
export const importManualDeploymentsRequestSchema = z.strictObject({
  sourceId: z.number().int().positive(),
  yaml: z.string().max(MANUAL_IMPORT_MAX_BYTES, 'The YAML file is too large (48 KiB at most)'),
  /** Also remove the entries of the source that the file does not list. Default: keep them. */
  replace: z.boolean().optional(),
})
export type ImportManualDeploymentsRequest = z.infer<typeof importManualDeploymentsRequestSchema>

export const importManualDeploymentsResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
})
export type ImportManualDeploymentsResponse = z.infer<typeof importManualDeploymentsResponseSchema>

const manualYamlSchema = z.strictObject({
  deployments: z.array(z.unknown()).max(MANUAL_IMPORT_MAX_ENTRIES),
})

export type ManualYamlResult =
  { ok: true; entries: ManualEntry[] } | { ok: false; errors: string[] }

/** Where an issue sits, as the reader of the file would look for it: `entry 3 (billing)`. */
function entryLabel(index: number, raw: unknown): string {
  const name =
    typeof raw === 'object' && raw !== null && 'name' in raw && typeof raw.name === 'string'
      ? raw.name.trim()
      : ''
  return name ? `entry ${index + 1} (${name})` : `entry ${index + 1}`
}

const ERRORS_SHOWN = 10

/**
 * Reads a YAML file of manual entries:
 *
 * ```yaml
 * deployments:
 *   - name: billing-api
 *     repo: example/billing
 *     domains: [https://billing.example.com]
 * ```
 *
 * Safe by construction: the size is capped, YAML 1.2 core types only (no custom tags), no
 * aliases (so no expansion attacks), one document, and keys the shape does not know are
 * refused rather than dropped, so a typo is reported instead of silently ignored.
 */
export function parseManualYaml(text: string): ManualYamlResult {
  if (text.length > MANUAL_IMPORT_MAX_BYTES) {
    return { ok: false, errors: ['The YAML file is too large (48 KiB at most).'] }
  }
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: false,
  })
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.slice(0, ERRORS_SHOWN).map((e) => `YAML: ${firstLine(e.message)}`),
    }
  }
  let data: unknown
  try {
    data = doc.toJS({ maxAliasCount: 0 })
  } catch {
    return { ok: false, errors: ['YAML: aliases and anchors are not allowed.'] }
  }
  const top = manualYamlSchema.safeParse(data)
  if (!top.success) {
    const issue = top.error.issues[0]
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : ''
    return {
      ok: false,
      errors: [
        `The file must be a map with one key, "deployments", holding a list of entries${where}.`,
      ],
    }
  }
  const entries: ManualEntry[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  top.data.deployments.forEach((raw, index) => {
    const label = entryLabel(index, raw)
    const parsed = manualEntrySchema.safeParse(raw)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.length ? `${issue.path.join('.')}: ` : ''
        errors.push(`${label}: ${field}${issue.message}`)
      }
      return
    }
    const entry = completeManualEntry(parsed.data)
    const key = entry.name.toLowerCase()
    if (seen.has(key)) errors.push(`${label}: the name is used twice in the file`)
    seen.add(key)
    entries.push(entry)
  })
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, ERRORS_SHOWN) }
  return { ok: true, entries }
}

const firstLine = (message: string): string => message.split('\n')[0] ?? message
