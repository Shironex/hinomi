import type { FixDispatchStep, FixStepReason } from '@hinomi/shared'
import type { Command, Exec } from '../exec.js'
import type { PublishTimes } from '../registry.js'
import type { RepoGate } from '../release-age.js'
import type { RepoFs } from '../repo-fs.js'

// One Applier per package manager. The pipeline (pipeline.ts) owns the order of things:
// reconcile, release age, edits, install with bisect, checks, patch. An Applier only knows
// how its package manager stores things and which commands it runs. Commands are argument
// arrays built from validated dispatch fields and run without a shell.

/** Package managers a dispatch step can name. */
export type StepPackageManager = FixDispatchStep['packageManager']

/** One project of the checkout: a lockfile and the folder it sits in. */
export interface ProjectContext {
  fs: RepoFs
  /** Repo relative folder of the lockfile, `.` for the repo root. */
  root: string
  /** Repo relative lockfile path. */
  lockfile: string
  /** Output of the version command, null when it could not run (detect step). */
  version: string | null
  publishTimes: PublishTimes
  exec: Exec
  now: Date
}

/** What happened to one step's edit. */
export type EditOutcome =
  | { status: 'edited'; files: string[] }
  | { status: 'skipped' | 'failed'; reason: FixStepReason; detail: string }

/** A check the pipeline runs in `full` mode. */
export interface CheckSpec {
  /** Canonical name: `lint`, `typecheck`, `test`, `build`, or a tool's own (`cargo check`). */
  name: string
  command: Command
}

export interface InstallOptions {
  /** The repo's own gate, so an applier can pass it to a tool that would not honour it. */
  repoGate: RepoGate | null
  /** The steps applied in this attempt, in plan order (a subset while bisecting). */
  steps: readonly FixDispatchStep[]
}

/** One command, or several the pipeline runs in order and stops at the first failure. */
export type InstallCommands = Command | Command[]

export interface Applier {
  readonly packageManager: StepPackageManager
  /** Lockfile names this applier owns, in the order detection prefers them. */
  readonly lockfiles: readonly string[]
  /** Prints the tool version, e.g. `pnpm --version`. */
  readonly versionCommand: Command

  /** Every version of `packageName` the lockfile resolves; empty when it is not there. */
  resolvedVersions(ctx: ProjectContext, packageName: string): Promise<string[]>
  /** The repo's own release age setting, null when it sets none. */
  releaseAgeGate(ctx: ProjectContext): Promise<RepoGate | null>
  /** Publish time of a version in this ecosystem's registry, null when unknown. */
  publishedAt(ctx: ProjectContext, packageName: string, version: string): Promise<Date | null>
  /**
   * Edits manifests for one step (manifest_bump or override; lockfile_update for tools that
   * have one). Must be deterministic and safe to repeat: bisect restores the tree and applies
   * subsets of the steps again.
   */
  applyStep(ctx: ProjectContext, step: FixDispatchStep): Promise<EditOutcome>
  /**
   * Updates only the lockfile after the edits. Must not run install scripts. Cargo returns
   * one `cargo update` per step; no command at all counts as a passing install.
   */
  lockfileInstall(
    ctx: ProjectContext,
    options: InstallOptions,
  ): InstallCommands | Promise<InstallCommands>
  /** The frozen install that precedes the checks in `full` mode. */
  fullInstall(ctx: ProjectContext): Command
  /** Checks the project defines, in the order they run. */
  checks(ctx: ProjectContext): Promise<CheckSpec[]>
}
