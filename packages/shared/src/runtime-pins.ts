import { z } from 'zod'
import { runtimePinSchema } from './guard-evidence.js'

// What a repo pins a runtime to, as read from its files (docs/design/phase-2.md section 5).
// `runtimePinSchema` (guard-evidence.ts) is the part evidence carries; a stored pin adds what the
// checks need to apply the precedence and disagreement rules.

/**
 * How a pin constrains the runtime.
 * - `exact`: one line or version (`22`, `22.11.0`, `node:22-alpine`, `lts/jod`).
 * - `range`: a semver range (`>=20 <23`, `^20`, `20.x`); `lineName` is the floor of the range.
 * - `floating`: a channel that moves by itself (`lts`, `latest`, `stable`, `nightly`).
 * - `minimum`: the lowest runtime the project supports, not the one that runs (Cargo
 *   `rust-version`). Never the running version, never a window check.
 * - `unknown`: a pin was found but its value cannot be read (a variable, an expression, a digest
 *   without a tag).
 */
export const PIN_KINDS = ['exact', 'range', 'floating', 'minimum', 'unknown'] as const
export const pinKindSchema = z.enum(PIN_KINDS)
export type PinKind = z.infer<typeof pinKindSchema>

/**
 * Where a pin applies. `production`: the final stage of a Dockerfile a deployment builds.
 * `ci`: a workflow step. `dev`: everything else (version files, `engines`, other Dockerfiles,
 * build stages, minimum versions).
 */
export const PIN_SCOPES = ['production', 'ci', 'dev'] as const
export const pinScopeSchema = z.enum(PIN_SCOPES)
export type PinScope = z.infer<typeof pinScopeSchema>

export const runtimePinRecordSchema = runtimePinSchema.extend({
  kind: pinKindSchema,
  /**
   * The value normalised: no `v` prefix, no image suffix, the channel for a floating pin
   * (`lts`, `stable`), the range for a range. Null for `unknown`.
   */
  version: z.string().nullable(),
  scope: pinScopeSchema,
  /** Workflow job id, so matrix entries of one job can be grouped. Null outside workflows. */
  job: z.string().nullable(),
  /** Dockerfile stage the pin was read from (0 based), null outside Dockerfiles. */
  stage: z.number().int().nonnegative().nullable(),
  /**
   * True when the Dockerfile stage reaches the final image: the final stage, one it is built on,
   * or one it copies `node_modules` from. Such a stage must run the production line (design
   * section 5.5). Null outside Dockerfiles.
   */
  finalStage: z.boolean().nullable(),
})
export type RuntimePinRecord = z.infer<typeof runtimePinRecordSchema>

/** A pin as stored and served: the record plus the ref it was read at and when. */
export interface StoredRuntimePin extends RuntimePinRecord {
  id: number
  repoId: number
  /** Branch or release tag the files were read at. */
  ref: string
  scannedAt: Date
}
