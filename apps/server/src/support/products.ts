import { z } from 'zod'
import { normalizePurl } from './purl.js'

// Reads the body of `GET https://endoflife.date/api/v1/products/full`. The body is untrusted
// input: every field is validated, a product that does not fit is skipped instead of failing the
// whole copy, and products are kept in Maps keyed by names from the response (never in a plain
// object, so a product called `__proto__` or `constructor` is just a name).

const MAX_NAME = 128
const MAX_LABEL = 256

/** `2026-04-30`. Anything else reads as "no date". */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  // A real calendar day: `2026-02-30` parses (as 2 March) but is not one.
  .refine((value) => {
    const at = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(at) && new Date(at).toISOString().startsWith(value)
  })
  .nullable()
  .catch(null)

const text = z.string().max(MAX_LABEL)

const releaseSchema = z.object({
  name: z.string().min(1).max(MAX_NAME),
  label: text.catch(''),
  releaseDate: dateSchema,
  isLts: z.boolean().catch(false),
  ltsFrom: dateSchema,
  isEoas: z.boolean().nullable().catch(null),
  eoasFrom: dateSchema,
  isEol: z.boolean().catch(false),
  eolFrom: dateSchema,
  latest: z.object({ name: text, date: dateSchema }).nullable().catch(null),
})

const identifierSchema = z.object({ type: z.string(), id: z.string() })

const productSchema = z.object({
  name: z.string().min(1).max(MAX_NAME),
  label: text.catch(''),
  aliases: z.array(z.string().min(1).max(MAX_NAME)).catch([]),
  category: text.catch(''),
  labels: z.object({ eol: text.nullable().catch(null) }).catch({ eol: null }),
  identifiers: z.array(z.unknown()).catch([]),
  releases: z.array(z.unknown()).catch([]),
})

const envelopeSchema = z.object({
  schema_version: z.string().max(MAX_NAME).nullable().catch(null),
  generated_at: z.string().max(MAX_NAME).nullable().catch(null),
  result: z.array(z.unknown()),
})

/** One release line of a product. Dates are `YYYY-MM-DD` (UTC days) or null. */
export interface SupportRelease {
  /** The line, as endoflife.date names it: `22`, `3.12`, `1.99`. */
  name: string
  label: string
  releaseDate: string | null
  isLts: boolean
  ltsFrom: string | null
  /** End of active support: from here only security fixes. Null when the product has none. */
  isEoas: boolean | null
  eoasFrom: string | null
  /** The date support ends (security support when the product publishes that). */
  isEol: boolean
  eolFrom: string | null
  latest: { name: string; date: string | null } | null
}

export interface SupportProduct {
  /** The slug: `nodejs`, `bun`, `rust`. */
  name: string
  label: string
  aliases: string[]
  category: string
  /** What the product calls its end of life date (`Security Support`, `Supported`, ...). */
  eolLabel: string | null
  /** Newest line first, as the API sends them. */
  releases: SupportRelease[]
  /** Normal form purls (see purl.ts). */
  purls: string[]
}

export interface ParsedSupportData {
  schemaVersion: string | null
  generatedAt: string | null
  products: Map<string, SupportProduct>
  /** Entries of the response that did not fit and were left out. */
  skipped: number
}

/** The body is not a product list Hinomi can use. */
export class SupportDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SupportDataError'
  }
}

function parseProduct(raw: unknown): SupportProduct | null {
  const parsed = productSchema.safeParse(raw)
  if (!parsed.success) return null
  const product = parsed.data
  const releases: SupportRelease[] = []
  const seen = new Set<string>()
  for (const entry of product.releases) {
    const release = releaseSchema.safeParse(entry)
    if (!release.success || seen.has(release.data.name)) continue
    seen.add(release.data.name)
    releases.push(release.data)
  }
  const purls = new Set<string>()
  for (const entry of product.identifiers) {
    const identifier = identifierSchema.safeParse(entry)
    if (!identifier.success || identifier.data.type !== 'purl') continue
    const key = normalizePurl(identifier.data.id)
    if (key) purls.add(key)
  }
  return {
    name: product.name,
    label: product.label,
    aliases: product.aliases,
    category: product.category,
    eolLabel: product.labels.eol,
    releases,
    purls: [...purls],
  }
}

/** Validates a `products/full` body. Throws SupportDataError when nothing usable is in it. */
export function parseProductsFull(body: string): ParsedSupportData {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (error) {
    throw new SupportDataError('The answer is not JSON', { cause: error })
  }
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) throw new SupportDataError('The answer has no product list')
  const products = new Map<string, SupportProduct>()
  let skipped = 0
  for (const raw of envelope.data.result) {
    const product = parseProduct(raw)
    // The first product of a name wins; a repeat is as untrustworthy as a malformed entry.
    if (!product || products.has(product.name)) {
      skipped++
      continue
    }
    products.set(product.name, product)
  }
  if (products.size === 0) throw new SupportDataError('The answer has no usable products')
  return {
    schemaVersion: envelope.data.schema_version,
    generatedAt: envelope.data.generated_at,
    products,
    skipped,
  }
}
