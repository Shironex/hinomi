import {
  FIX_RESULT_SCHEMA,
  decodeFixDispatch,
  parseFixResult,
  truncateCheckOutput,
  type FixCheckResult,
  type FixDispatchStep,
  type FixDispatchV1,
  type FixReleaseAgeCheck,
  type FixResultStep,
  type FixResultV1,
} from '@hinomi/shared'
import type { Logger } from './actions-io.js'
import {
  APPLIERS,
  type Applier,
  type InstallOptions,
  type ProjectContext,
  type StepPackageManager,
} from './appliers/index.js'
import { bisectInstall, firstErrorLine, type Attempt } from './bisect.js'
import { selectChecks, type ChecksSelection } from './checks-input.js'
import { nodeCompressor } from './compressor.js'
import { detectProject } from './detect.js'
import { FixRunnerError } from './errors.js'
import { formatCommand, type Command, type Exec } from './exec.js'
import { createGit, takeSnapshot, type Git, type Snapshot } from './git.js'
import { capturePatch, type CapturedPatch } from './patch.js'
import type { PublishTimes } from './registry.js'
import { checkReleaseAge, effectiveGate, type RepoGate } from './release-age.js'
import { repoDirname, type RepoFs } from './repo-fs.js'
import { atLeast } from './semver.js'
import { planToolchains, type ToolchainProject, type Toolchains } from './toolchain.js'

// The apply job, start to end: decode and validate the dispatch, match it with the checkout,
// then per project (one lockfile) reconcile each step with the live lockfile, check its
// release age, edit manifests, update the lockfile (bisecting a failed install down to the
// steps that broke it), capture the patch, and in full mode install and run the checks.
// Nothing the repo's own code runs (install scripts, checks) happens before the patch is
// captured, so it cannot change what the fix PR carries.

export const INSTALL_TIMEOUT_MS = 15 * 60_000
export const CHECK_TIMEOUT_MS = 15 * 60_000
const VERSION_TIMEOUT_MS = 60_000

export interface RunnerDeps {
  fs: RepoFs
  exec: Exec
  publishTimes: PublishTimes
  log: Logger
  now: () => Date
  appliers?: ReadonlyMap<StepPackageManager, Applier>
}

export interface DispatchInputs {
  /** The `plan` input. */
  plan: string
  /** The `encoding` input. */
  encoding: string
  /** The `run_id` input; when set it must match the dispatch. */
  runId: string
  /** `github.repository` of the run; the dispatch must name the same repo. */
  repository: string
}

export interface ApplyInputs extends DispatchInputs {
  /** The `checks` input: auto, install, full or a comma list. */
  checks: string
}

/** Decodes, validates and matches the dispatch with this run. Throws on anything off. */
export async function readDispatch(inputs: DispatchInputs): Promise<FixDispatchV1> {
  const encoding = inputs.encoding === '' ? 'json' : inputs.encoding
  const dispatch = await decodeFixDispatch(inputs.plan, encoding, { compressor: nodeCompressor })
  if (dispatch.repo.fullName.toLowerCase() !== inputs.repository.toLowerCase()) {
    throw new FixRunnerError(
      `The dispatch is for ${dispatch.repo.fullName}, this run is in ${inputs.repository}`,
    )
  }
  if (inputs.runId !== '' && inputs.runId !== dispatch.runId) {
    throw new FixRunnerError(`The run_id input ${inputs.runId} differs from the dispatch's`)
  }
  return dispatch
}

interface Project {
  root: string
  lockfile: string
  packageManager: StepPackageManager
  steps: FixDispatchStep[]
}

/** Steps grouped by lockfile, projects in the order their first step comes. */
export function groupProjects(steps: FixDispatchStep[]): Project[] {
  const projects = new Map<string, Project>()
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    let project = projects.get(step.lockfile)
    if (!project) {
      project = {
        root: repoDirname(step.lockfile),
        lockfile: step.lockfile,
        packageManager: step.packageManager,
        steps: [],
      }
      projects.set(step.lockfile, project)
    }
    project.steps.push(step)
  }
  return [...projects.values()]
}

/** The lockfile install commands of an applier as a list, in the order they run. */
export async function installCommands(
  applier: Applier,
  ctx: ProjectContext,
  options: InstallOptions,
): Promise<Command[]> {
  return [await applier.lockfileInstall(ctx, options)].flat()
}

type Verdict = { apply: true } | Omit<FixResultStep, 'id' | 'files'>

/** Compares a step with what the live lockfile resolves. */
export function reconcileStep(step: FixDispatchStep, resolved: string[]): Verdict {
  if (resolved.length === 0) {
    return {
      status: 'skipped',
      reason: 'not_in_lockfile',
      detail: `${step.packageName} is not in ${step.lockfile}`,
    }
  }
  if (resolved.every((version) => atLeast(version, step.to))) {
    return {
      status: 'skipped',
      reason: 'already_fixed',
      detail: `${step.lockfile} already resolves ${resolved.join(', ')}`,
    }
  }
  return { apply: true }
}

interface InstallLog {
  ran: boolean
  failed: boolean
  durationMs: number
  output: string
}

interface ProjectRun {
  project: Project
  applier: Applier
  ctx: ProjectContext
  /** The tree before this project's edits, which bisect returns to. */
  snapshot: Snapshot
  applied: string[]
  installFailed: boolean
}

class ApplyRun {
  readonly records = new Map<string, FixResultStep>()
  readonly releaseAge: FixReleaseAgeCheck[] = []
  readonly checks: FixCheckResult[] = []
  readonly install: InstallLog = { ran: false, failed: false, durationMs: 0, output: '' }
  readonly stepFiles = new Set<string>()
  readonly git: Git
  readonly appliers: ReadonlyMap<StepPackageManager, Applier>

  constructor(
    readonly dispatch: FixDispatchV1,
    readonly deps: RunnerDeps,
    readonly now: Date,
  ) {
    this.git = createGit(deps.exec, deps.fs.root)
    this.appliers = deps.appliers ?? APPLIERS
  }

  record(step: FixDispatchStep, entry: Omit<FixResultStep, 'id'>) {
    this.records.set(step.id, { id: step.id, ...entry })
  }

  failAll(steps: FixDispatchStep[], detail: string) {
    for (const step of steps) {
      this.record(step, { status: 'failed', reason: 'edit_failed', detail, files: [] })
    }
  }

  async run(command: Command, root: string, timeoutMs: number) {
    const { log, exec, fs } = this.deps
    return log.group(`${root} $ ${formatCommand(command)}`, () =>
      exec.run(command, { cwd: fs.absolute(root), timeoutMs }),
    )
  }

  async lockfileInstall(
    entry: ProjectRun,
    repoGate: RepoGate | null,
    steps: readonly FixDispatchStep[],
  ): Promise<Attempt> {
    const commands = await installCommands(entry.applier, entry.ctx, { repoGate, steps })
    this.install.ran = true
    const outputs: string[] = []
    for (const command of commands) {
      const result = await this.run(command, entry.project.root, INSTALL_TIMEOUT_MS)
      this.install.durationMs += result.durationMs
      outputs.push(result.output)
      if (result.code !== 0) return { ok: false, output: outputs.join('\n') }
    }
    return { ok: true, output: outputs.join('\n') }
  }

  /** Opens a project: detection, applier, tool version. Null when its steps cannot run. */
  async openProject(project: Project): Promise<ProjectRun | null> {
    const { fs, exec, publishTimes, log } = this.deps
    const detected = await detectProject(fs, project.root)
    if (!detected.ok) {
      this.failAll(project.steps, `package manager check failed: ${detected.problem}`)
      return null
    }
    const found = detected.project
    if (found.packageManager !== project.packageManager || found.lockfile !== project.lockfile) {
      this.failAll(
        project.steps,
        `package manager mismatch: the dispatch says ${project.packageManager} with ${project.lockfile}, the checkout has ${found.packageManager} with ${found.lockfile}`,
      )
      return null
    }
    const applier = this.appliers.get(project.packageManager)
    if (!applier) {
      this.failAll(project.steps, `this runner has no applier for ${project.packageManager} yet`)
      return null
    }
    const version = await exec.run(applier.versionCommand, {
      cwd: fs.absolute(project.root),
      timeoutMs: VERSION_TIMEOUT_MS,
    })
    const ctx: ProjectContext = {
      fs,
      root: project.root,
      lockfile: project.lockfile,
      version: version.code === 0 ? version.output.trim().split('\n').pop()?.trim() || null : null,
      publishTimes,
      exec,
      now: this.now,
    }
    log.info('project', {
      lockfile: project.lockfile,
      packageManager: applier.packageManager,
      version: ctx.version,
    })
    const snapshot = await takeSnapshot(this.git, fs)
    return { project, applier, ctx, snapshot, applied: [], installFailed: false }
  }

  /** Reconcile, release age and edits for one project; returns the edited step ids. */
  async editProject(entry: ProjectRun, repoGate: RepoGate | null): Promise<FixDispatchStep[]> {
    const { applier, ctx } = entry
    const edited: FixDispatchStep[] = []
    for (const step of entry.project.steps) {
      const verdict = reconcileStep(step, await applier.resolvedVersions(ctx, step.packageName))
      if (!('apply' in verdict)) {
        this.record(step, { ...verdict, files: [] })
        continue
      }
      const gate = effectiveGate(
        this.dispatch.options.releaseAgeDays,
        repoGate,
        step.packageName,
        step.to,
      )
      const check = checkReleaseAge({
        stepId: step.id,
        packageName: step.packageName,
        version: step.to,
        publishedAt: await applier.publishedAt(ctx, step.packageName, step.to),
        gate,
        now: this.now,
      })
      this.releaseAge.push(check)
      if (check.status !== 'clear') {
        // An unknown publish time cannot prove the gate, so it holds the step back too.
        const detail =
          check.status === 'too_new'
            ? `eligible on ${check.eligibleAt ?? 'unknown'} (${gate.days} day gate from ${gate.source})`
            : 'the registry gave no publish time, so the release age could not be checked'
        this.record(step, { status: 'skipped', reason: 'too_new', detail, files: [] })
        continue
      }
      const outcome = await applier.applyStep(ctx, step)
      if (outcome.status === 'edited') {
        this.record(step, { status: 'applied', reason: null, detail: null, files: outcome.files })
        edited.push(step)
      } else {
        this.record(step, { ...outcome, files: [] })
      }
    }
    return edited
  }

  async installProject(entry: ProjectRun, repoGate: RepoGate | null, edited: FixDispatchStep[]) {
    const first = await this.lockfileInstall(entry, repoGate, edited)
    if (first.ok) {
      entry.applied = edited.map((step) => step.id)
      return
    }
    const { log } = this.deps
    log.warning('The lockfile install failed with every step, bisecting', {
      lockfile: entry.project.lockfile,
    })
    const { snapshot } = entry
    const byId = new Map(edited.map((step) => [step.id, step]))
    const result = await bisectInstall([...byId.keys()], first, {
      attempt: async (ids) => {
        await snapshot.restore()
        const steps = ids.flatMap((id) => byId.get(id) ?? [])
        for (const step of steps) await entry.applier.applyStep(entry.ctx, step)
        return this.lockfileInstall(entry, repoGate, steps)
      },
    })
    for (const [id, detail] of result.failed) {
      const step = byId.get(id)
      if (step) {
        this.record(step, { status: 'failed', reason: 'install_failed', detail, files: [] })
      }
    }
    entry.applied = result.kept
    if (result.baselineBroken || !result.lastAttempt.ok) {
      const detail = `install failed: ${firstErrorLine(result.lastAttempt.output)}`
      for (const id of result.kept) {
        const step = byId.get(id)
        if (step) {
          this.record(step, { status: 'failed', reason: 'install_failed', detail, files: [] })
        }
      }
      entry.installFailed = true
      this.install.failed = true
      this.install.output = result.lastAttempt.output
      await snapshot.restore()
      entry.applied = []
    } else if (result.failed.size > 0) {
      const failing = [...result.failed.values()][0] ?? ''
      log.warning('Steps broke the install and were left out', {
        steps: result.failed.size,
        error: firstErrorLine(failing),
      })
    }
  }

  async checkProject(entry: ProjectRun, selection: ChecksSelection) {
    const { applier, ctx, project } = entry
    const prefix = project.root === '.' ? '' : `${project.root}: `
    const install = await this.run(applier.fullInstall(ctx), project.root, INSTALL_TIMEOUT_MS)
    this.install.durationMs += install.durationMs
    const specs = (await applier.checks(ctx)).filter(
      (spec) => selection.only === null || selection.only.includes(spec.name),
    )
    if (install.code !== 0) {
      this.install.failed = true
      this.install.output = install.output
      for (const spec of specs) {
        this.checks.push({
          name: `${prefix}${spec.name}`,
          command: formatCommand(spec.command),
          status: 'skipped',
          durationMs: 0,
          output: 'skipped: the install failed',
          truncated: false,
        })
      }
      return
    }
    this.install.output = install.output
    for (const spec of specs) {
      const result = await this.run(spec.command, project.root, CHECK_TIMEOUT_MS)
      const tail = truncateCheckOutput(result.output)
      this.checks.push({
        name: `${prefix}${spec.name}`,
        command: formatCommand(spec.command),
        status: result.timedOut ? 'timeout' : result.code === 0 ? 'passed' : 'failed',
        durationMs: result.durationMs,
        output: tail.output === '' ? null : tail.output,
        truncated: tail.truncated,
      })
    }
  }
}

export interface DetectOutcome {
  dispatch: FixDispatchV1
  /** Empty when detection failed; `problem` says why. */
  packageManager: StepPackageManager | ''
  /** From the `packageManager` field, for the toolchain setup. */
  packageManagerVersion: string
  lockfile: string
  /** Repo relative folder of the lockfile. */
  root: string
  /** The first project's problem, empty when it matched. */
  problem: string
  /** What to set up for every project that matched the checkout. */
  toolchains: Toolchains
  /** One line per project whose package manager could not be matched. */
  problems: string[]
}

/**
 * The detect step, before the toolchain is set up: validates the dispatch and detects the
 * package manager of every project, so the workflow installs each tool the dispatch needs
 * (mixed ecosystems get every manager). The single project outputs name the first project.
 */
export async function runDetect(inputs: DispatchInputs, fs: RepoFs): Promise<DetectOutcome> {
  const dispatch = await readDispatch(inputs)
  const projects = groupProjects(dispatch.steps)
  const matched: ToolchainProject[] = []
  const entries: ProjectDetection[] = []
  for (const project of projects) {
    const entry = await detectOne(fs, project.root, project.packageManager)
    if (entry.packageManager !== '') {
      matched.push({ root: entry.root, packageManager: entry.packageManager })
    }
    entries.push(entry)
  }
  const first = entries[0] ?? (await detectOne(fs, '.', null))
  const problems = entries
    .filter((entry) => entry.problem !== '')
    .map((entry) => `${entry.root}: ${entry.problem}`)
  const toolchains = await planToolchains(fs, matched)
  return { dispatch, ...first, toolchains, problems }
}

type ProjectDetection = Omit<DetectOutcome, 'dispatch' | 'toolchains' | 'problems'>

async function detectOne(
  fs: RepoFs,
  root: string,
  expected: StepPackageManager | null,
): Promise<ProjectDetection> {
  const detected = await detectProject(fs, root)
  if (!detected.ok) {
    return {
      packageManager: '',
      packageManagerVersion: '',
      lockfile: '',
      root,
      problem: detected.problem,
    }
  }
  const found = detected.project
  return {
    packageManager: found.packageManager,
    packageManagerVersion: found.declaredVersion ?? '',
    lockfile: found.lockfile,
    root,
    problem:
      expected !== null && expected !== found.packageManager
        ? `the dispatch says ${expected}, the checkout has ${found.packageManager}`
        : '',
  }
}

export interface ApplyOutcome {
  result: FixResultV1
  /** The patch text, null when nothing changed. */
  patch: string | null
  captured: CapturedPatch
  dispatch: FixDispatchV1
}

/** Runs the whole apply job against the checkout in `deps.fs.root`. */
export async function runApply(inputs: ApplyInputs, deps: RunnerDeps): Promise<ApplyOutcome> {
  const dispatch = await readDispatch(inputs)
  const selection = selectChecks(inputs.checks, dispatch.options.checks)
  const run = new ApplyRun(dispatch, deps, deps.now())
  const { log } = deps

  const baseSha = await run.git.headSha()
  const dirty = await run.git.changedFiles()
  if (dirty.length > 0) {
    throw new FixRunnerError(`The checkout has local changes: ${dirty.slice(0, 5).join(', ')}`)
  }
  log.info('dispatch', {
    runId: dispatch.runId,
    steps: dispatch.steps.length,
    checks: selection.mode,
    releaseAgeFloorDays: dispatch.options.releaseAgeDays,
  })

  const opened: ProjectRun[] = []
  for (const project of groupProjects(dispatch.steps)) {
    const entry = await run.openProject(project)
    if (!entry) continue
    const repoGate = await entry.applier.releaseAgeGate(entry.ctx)
    const edited = await run.editProject(entry, repoGate)
    if (edited.length > 0) await run.installProject(entry, repoGate, edited)
    opened.push(entry)
  }

  for (const entry of opened) {
    for (const id of entry.applied) {
      for (const file of run.records.get(id)?.files ?? []) run.stepFiles.add(file)
    }
  }
  const captured = await capturePatch(run.git, run.stepFiles)
  for (const path of captured.ignored) log.warning('Left out of the patch', { path })

  if (selection.mode === 'full' && captured.text !== null) {
    for (const entry of opened) {
      if (entry.applied.length > 0 && !entry.installFailed) await run.checkProject(entry, selection)
    }
  }

  const primary = opened[0]
  const installTail = truncateCheckOutput(run.install.output)
  const result = parseFixResult({
    schema: FIX_RESULT_SCHEMA,
    runId: dispatch.runId,
    planScanRunId: dispatch.plan.scanRunId,
    repo: dispatch.repo.fullName,
    baseSha,
    packageManager:
      primary?.applier.packageManager ?? dispatch.steps[0]?.packageManager ?? 'unknown',
    packageManagerVersion: primary?.ctx.version ?? null,
    checksMode: selection.mode,
    steps: dispatch.steps.map(
      (step) =>
        run.records.get(step.id) ?? {
          id: step.id,
          status: 'failed',
          reason: 'edit_failed',
          detail: 'the runner did not reach this step',
          files: [],
        },
    ),
    releaseAge: run.releaseAge,
    install: {
      status: !run.install.ran ? 'skipped' : run.install.failed ? 'failed' : 'ok',
      durationMs: run.install.durationMs,
      output: installTail.output === '' ? null : installTail.output,
      truncated: installTail.truncated,
    },
    checks: run.checks,
    patch:
      captured.text === null || captured.sha256 === null
        ? null
        : {
            sha256: captured.sha256,
            files: captured.files,
            insertions: captured.insertions,
            deletions: captured.deletions,
          },
    finishedAt: deps.now().toISOString(),
  })
  return { result, patch: captured.text, captured, dispatch }
}
