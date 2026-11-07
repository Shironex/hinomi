import { FINDING_TIERS } from './api.js'
import { FixPayloadError, parseFixDispatch, type FixDispatchV1 } from './runner.js'

// Encoding of a FixDispatchV1 into the workflow_dispatch input `plan`. GitHub caps the whole
// inputs payload at 65,535 characters, so the plan input gets a budget with headroom for the
// other inputs. Plain JSON when it fits, else gzip plus base64, else the payload is trimmed by
// priority (risky entries, then advisory lists, then the least urgent steps) before it fails.

/** GitHub's limit on the serialized inputs of one workflow_dispatch. */
export const WORKFLOW_DISPATCH_INPUT_LIMIT = 65_535
/** Characters the `plan` input may use, leaving room for the run id and encoding inputs. */
export const FIX_DISPATCH_PAYLOAD_BUDGET = 60_000

export const FIX_DISPATCH_ENCODINGS = ['json', 'gzip-base64'] as const
export type FixDispatchEncoding = (typeof FIX_DISPATCH_ENCODINGS)[number]

/**
 * gzip plus base64, supplied by the platform (node:zlib on the server and in the runner), so
 * this package stays free of platform APIs. `decompress` must cap its output (for example
 * zlib's `maxOutputLength`), since the payload comes from outside.
 */
export interface FixPayloadCompressor {
  /** gzip the UTF-8 bytes of `text` and return them as standard base64. */
  compress(text: string): Promise<string>
  /** The reverse of `compress`. */
  decompress(base64: string): Promise<string>
}

export interface EncodedFixDispatch {
  encoding: FixDispatchEncoding
  /** The value of the `plan` input. */
  payload: string
  /** The dispatch as sent, after any trimming. */
  dispatch: FixDispatchV1
  /** Ids of the steps the budget left out, least urgent first; they wait for the next run. */
  omittedStepIds: string[]
}

export interface EncodeFixDispatchOptions {
  compressor: FixPayloadCompressor
  /** Defaults to FIX_DISPATCH_PAYLOAD_BUDGET. */
  budget?: number
}

async function tryEncode(
  dispatch: FixDispatchV1,
  compressor: FixPayloadCompressor,
  budget: number,
): Promise<Pick<EncodedFixDispatch, 'encoding' | 'payload'> | null> {
  const json = JSON.stringify(dispatch)
  if (json.length <= budget) return { encoding: 'json', payload: json }
  const packed = await compressor.compress(json)
  return packed.length <= budget ? { encoding: 'gzip-base64', payload: packed } : null
}

function withoutRisky(dispatch: FixDispatchV1): FixDispatchV1 {
  const omitted = { ...dispatch.omitted, risky: dispatch.omitted.risky + dispatch.risky.length }
  return { ...dispatch, risky: [], omitted }
}

function withoutAdvisories(dispatch: FixDispatchV1): FixDispatchV1 {
  return {
    ...dispatch,
    steps: dispatch.steps.map((step) => ({ ...step, advisories: [] })),
    omitted: { ...dispatch.omitted, advisories: true },
  }
}

/** Steps most urgent first: by tier, then by plan order. */
function byPriority(dispatch: FixDispatchV1): FixDispatchV1['steps'] {
  const rank = (tier: string) => FINDING_TIERS.indexOf(tier as (typeof FINDING_TIERS)[number])
  return [...dispatch.steps].sort((a, b) => rank(a.tier) - rank(b.tier) || a.order - b.order)
}

function keepSteps(dispatch: FixDispatchV1, ranked: FixDispatchV1['steps'], keep: number) {
  const kept = new Set(ranked.slice(0, keep).map((step) => step.id))
  const steps = dispatch.steps.filter((step) => kept.has(step.id))
  const dropped = dispatch.steps.length - steps.length
  return {
    ...dispatch,
    steps,
    omitted: { ...dispatch.omitted, steps: dispatch.omitted.steps + dropped },
  }
}

/**
 * Encodes a dispatch for the `plan` input within the budget. When even gzip does not fit, it
 * drops the risky entries, then the advisory lists, then the least urgent steps (keeping as
 * many as fit), and records what it left out in `omitted`. It throws FixPayloadError
 * `too_large` only when not one step fits.
 */
export async function encodeFixDispatch(
  dispatch: FixDispatchV1,
  options: EncodeFixDispatchOptions,
): Promise<EncodedFixDispatch> {
  const budget = options.budget ?? FIX_DISPATCH_PAYLOAD_BUDGET
  const { compressor } = options
  const full = await tryEncode(dispatch, compressor, budget)
  if (full) return { ...full, dispatch, omittedStepIds: [] }

  const lean = withoutAdvisories(withoutRisky(dispatch))
  const ranked = byPriority(lean)
  // Binary search for the most steps that still fit; at least one must.
  let low = 1
  let high = ranked.length
  let best: EncodedFixDispatch | null = null
  while (low <= high) {
    const keep = Math.floor((low + high) / 2)
    const candidate = keepSteps(lean, ranked, keep)
    const encoded = await tryEncode(candidate, compressor, budget)
    if (encoded) {
      const omittedStepIds = ranked.slice(keep).map((step) => step.id)
      best = { ...encoded, dispatch: candidate, omittedStepIds }
      low = keep + 1
    } else {
      high = keep - 1
    }
  }
  if (best) return best
  throw new FixPayloadError(
    'too_large',
    `The fix dispatch does not fit in ${budget} characters even with one step`,
  )
}

export interface DecodeFixDispatchOptions {
  compressor: FixPayloadCompressor
}

/**
 * Decodes the `plan` input back into a validated dispatch. Throws FixPayloadError: too_large
 * over the input limit, malformed for an unknown encoding or bad JSON, unsupported_version for
 * a schema or plan version this runner does not know.
 */
export async function decodeFixDispatch(
  payload: string,
  encoding: string,
  options: DecodeFixDispatchOptions,
): Promise<FixDispatchV1> {
  if (payload.length > WORKFLOW_DISPATCH_INPUT_LIMIT) {
    throw new FixPayloadError('too_large', 'The plan input is over the workflow_dispatch limit')
  }
  let text: string
  if (encoding === 'json') {
    text = payload
  } else if (encoding === 'gzip-base64') {
    try {
      text = await options.compressor.decompress(payload)
    } catch (error) {
      throw new FixPayloadError('malformed', 'The plan input is not gzip plus base64', {
        cause: error,
      })
    }
  } else {
    throw new FixPayloadError('malformed', `Unknown plan encoding ${JSON.stringify(encoding)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new FixPayloadError('malformed', 'The plan input is not JSON', { cause: error })
  }
  return parseFixDispatch(value)
}
