import type {
  GuardCapability,
  GuardCheck,
  GuardEvidence,
  GuardEvidenceInput,
  GuardLevel,
  SourceKind,
} from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import type { GuardSubject } from '../../repository/index.js'
import type { RepoScan } from '../collect.js'
import type { DeploymentIndex } from '../deployments.js'

export type { GuardSubject }

/**
 * What a check says about one subject (see docs/guards.md):
 * - `pass`: no finding; an open one is resolved. Evidence is optional and kept on the row.
 * - `warn`, `fail`: the finding opens (or stays open) at that level.
 * - `unknown`: the source cannot give the signal. Never a silent pass: the finding shows in the
 *   coverage tier and is never notified.
 * - `null`: the check could not run on it this time (a fetch failed); the row is left alone.
 * Subjects a check leaves out are left alone too.
 */
export type GuardSubjectResult =
  | { subject: GuardSubject; level: null }
  | { subject: GuardSubject; level: 'pass'; evidence?: GuardEvidenceInput }
  | { subject: GuardSubject; level: GuardLevel; evidence: GuardEvidenceInput }

/**
 * What a check reads. Built once per scan in the ranking phase, after the deployments, alerts
 * and lockfiles phases. Later slices add their inputs here (deployment facts, the support data
 * index) and fill them where `runScan` builds the context.
 */
export interface GuardContext {
  /** Every deployment the sources reported. */
  deployments: readonly DeploymentRow[]
  /** Repos scanned this run. */
  repos: readonly RepoRow[]
  /** Deployments by repo (manual mappings honoured) and the unmapped ones. */
  index: DeploymentIndex
  /** This scan's results per repo id: health, alerts and the lockfiles OSV read. */
  scans: ReadonlyMap<number, RepoScan>
  now: Date
}

/**
 * One registered check. `run` is called once per scan; it may be async (a fetch at a commit),
 * should return a result for every subject it evaluated, and may throw (the scan logs it and
 * leaves that check's findings alone).
 */
export interface Guard {
  check: GuardCheck
  /** How much of the check each kind of deployment source can answer (GET /api/guards). */
  capabilities: Partial<Record<SourceKind, GuardCapability>>
  run(ctx: GuardContext): readonly GuardSubjectResult[] | Promise<readonly GuardSubjectResult[]>
}

/** A validated, deduplicated result, ready for `applyGuards`. */
export type GuardOutcome =
  | { check: GuardCheck; subject: GuardSubject; level: 'pass'; evidence: GuardEvidence | null }
  | { check: GuardCheck; subject: GuardSubject; level: GuardLevel; evidence: GuardEvidence }
