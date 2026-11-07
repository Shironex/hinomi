import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FIX_RESULT_SCHEMA,
  parseFixResult,
  truncateCheckOutput,
  type FixAgentOutcome,
  type FixAgentPreset,
  type FixDispatchV1,
  type FixResultStep,
  type FixResultV1,
} from '@hinomi/shared'
import type { Logger } from './actions-io.js'
import { AGENT_PRESETS, renderAgentPrompt, type AgentPreset, type AgentReading } from './agents.js'
import { firstErrorLine } from './bisect.js'
import { FixRunnerError } from './errors.js'
import { formatCommand, type Exec } from './exec.js'
import { createGit } from './git.js'
import { captureMajorsPatch, type CapturedPatch } from './patch.js'
import { readDispatch, type DispatchInputs } from './pipeline.js'
import type { RepoFs } from './repo-fs.js'

// The agent step of the majors job: runs the dispatch's coding agent preset on the checkout of
// the base commit, then captures what it changed as the majors patch (see patch.ts for its
// limits) and writes a result whose `agent` field reports the run. The job's token is read
// only; a separate publish job verifies the patch and pushes hinomi/majors.
//
// The checkout's .git folder is moved out of reach while the agent runs and put back after,
// so nothing the agent writes (a git config with a filter or fsmonitor command, hooks) can
// run when the runner itself calls git to capture the patch.

const SETUP_TIMEOUT_MS = 10 * 60_000

export interface AgentStepInputs extends DispatchInputs {
  /** The dry_run input: the stub preset is accepted only then. */
  dryRun: boolean
  /** The agent_secret input, empty when the caller passed none. */
  secret: string
  /** Absolute scratch folder outside the checkout (RUNNER_TEMP). */
  tempDir: string
}

export interface AgentStepDeps {
  fs: RepoFs
  exec: Exec
  log: Logger
  now: () => Date
  presets?: ReadonlyMap<FixAgentPreset, AgentPreset>
}

export interface AgentStepOutcome {
  dispatch: FixDispatchV1
  result: FixResultV1
  /** The patch text, null when there is nothing to publish. */
  patch: string | null
}

interface AgentRun {
  outcome: FixAgentOutcome
  detail: string | null
  reading: AgentReading | null
  durationMs: number
  captured: CapturedPatch | null
  refused: string[]
}

/** The preset the dispatch names, checked against the dry run rule. */
function presetOf(
  dispatch: FixDispatchV1,
  inputs: AgentStepInputs,
  presets: ReadonlyMap<FixAgentPreset, AgentPreset>,
): AgentPreset {
  const name = dispatch.options.agentPreset ?? 'claude-code'
  const preset = presets.get(name)
  if (!preset) throw new FixRunnerError(`This runner has no ${name} agent preset`)
  if (preset.dryRunOnly && !inputs.dryRun) {
    throw new FixRunnerError(`The ${name} agent preset runs only with dry_run: true`)
  }
  return preset
}

/** Runs `work` with the checkout's .git folder parked in `tempDir`, then puts it back. */
async function withoutGitDir<T>(root: string, tempDir: string, work: () => Promise<T>): Promise<T> {
  const gitDir = join(root, '.git')
  const parked = join(tempDir, 'hinomi-parked-git')
  await rm(parked, { recursive: true, force: true })
  await rename(gitDir, parked)
  try {
    return await work()
  } finally {
    await rm(gitDir, { recursive: true, force: true })
    await rename(parked, gitDir)
  }
}

/** Prepares the runner and runs the agent. Returns the detail of a failed setup instead. */
async function runAgent(
  preset: AgentPreset,
  dispatch: FixDispatchV1,
  inputs: AgentStepInputs,
  deps: AgentStepDeps,
): Promise<{ reading: AgentReading; timedOut: boolean; code: number | null } | string> {
  const { exec, fs, log } = deps
  const dir = join(inputs.tempDir, 'hinomi-agent')
  await mkdir(dir, { recursive: true })
  const prompt = renderAgentPrompt(dispatch)
  const promptFile = join(dir, 'prompt.md')
  await writeFile(promptFile, prompt, 'utf8')
  const context = {
    workspace: fs.root,
    tempDir: dir,
    promptFile,
    prompt,
    secret: inputs.secret,
    dispatch,
  }
  for (const command of preset.setup(context)) {
    const result = await log.group(`setup $ ${formatCommand(command)}`, () =>
      exec.run(command, { cwd: dir, timeoutMs: SETUP_TIMEOUT_MS }),
    )
    if (result.code !== 0) {
      return `setup failed at ${command.file} ${command.args[0] ?? ''}: ${firstErrorLine(result.output)}`
    }
  }
  const command = preset.command(context)
  log.info('agent', { preset: preset.name, upgrades: dispatch.risky.length })
  const result = await log.group(`agent ${preset.name}`, () =>
    exec.run(command, { cwd: fs.root, timeoutMs: preset.timeoutMs, processGroup: true }),
  )
  return { reading: preset.read(result.output), timedOut: result.timedOut, code: result.code }
}

function outcomeOf(
  ran: { reading: AgentReading; timedOut: boolean; code: number | null },
  presetTimeoutMs: number,
): { outcome: FixAgentOutcome; detail: string | null } {
  if (ran.timedOut) {
    const minutes = Math.round(presetTimeoutMs / 60_000)
    return { outcome: 'timeout', detail: `the runner stopped the agent after ${minutes} minutes` }
  }
  if (ran.code !== 0) {
    return {
      outcome: 'failed',
      detail: ran.reading.error ?? `the agent exited with code ${ran.code ?? 'none'}`,
    }
  }
  if (ran.reading.error) return { outcome: 'failed', detail: ran.reading.error }
  // A run that reports no turn and no cost reached no model: a bad key or a usage limit.
  if (ran.reading.turns === 0 && ran.reading.costUsd === 0 && ran.reading.summary === null) {
    return {
      outcome: 'failed',
      detail: 'the agent made no model request (check the key and its usage limits)',
    }
  }
  return { outcome: 'changed', detail: null }
}

async function agentRun(
  preset: AgentPreset,
  dispatch: FixDispatchV1,
  inputs: AgentStepInputs,
  deps: AgentStepDeps,
  baseSha: string,
): Promise<AgentRun> {
  const started = deps.now().getTime()
  const elapsed = () => Math.max(0, deps.now().getTime() - started)
  const none = { reading: null, captured: null, refused: [] }
  if (preset.secretName !== null && inputs.secret === '') {
    const detail = `the caller workflow passes no ${preset.secretName} secret to the reusable workflow (docs/github.md)`
    return { outcome: 'failed', detail, durationMs: 0, ...none }
  }
  const ran = await withoutGitDir(deps.fs.root, inputs.tempDir, () =>
    runAgent(preset, dispatch, inputs, deps),
  )
  if (typeof ran === 'string')
    return { outcome: 'failed', detail: ran, durationMs: elapsed(), ...none }
  const durationMs = elapsed()
  const ended = outcomeOf(ran, preset.timeoutMs)
  const captured = await captureMajorsPatch(createGit(deps.exec, deps.fs.root), baseSha)
  for (const path of captured.refused) deps.log.warning('Left out of the majors patch', { path })
  if (captured.kind === 'over_limit') {
    return {
      outcome: 'refused',
      detail: captured.detail,
      reading: ran.reading,
      durationMs,
      captured: null,
      refused: captured.refused,
    }
  }
  const changed = captured.patch.text !== null
  // A failed or stopped agent keeps its outcome; its partial changes still go to the draft.
  const outcome = ended.outcome === 'changed' && !changed ? 'no_changes' : ended.outcome
  return {
    outcome,
    detail: ended.detail,
    reading: ran.reading,
    durationMs,
    captured: changed ? captured.patch : null,
    refused: captured.refused,
  }
}

/** The risky steps the agent was handed, `applied` when the patch changes their lockfile. */
function handedSteps(dispatch: FixDispatchV1, files: readonly string[]): FixResultStep[] {
  return dispatch.risky.map((risky) => {
    const changed = risky.lockfile !== null && files.includes(risky.lockfile)
    return {
      id: risky.id,
      status: changed ? 'applied' : 'skipped',
      reason: null,
      detail: changed ? null : `the agent left ${risky.lockfile ?? 'the lockfile'} unchanged`,
      files: [],
    }
  })
}

/** Runs the agent step against the checkout in `deps.fs.root`. */
export async function runAgentStep(
  inputs: AgentStepInputs,
  deps: AgentStepDeps,
): Promise<AgentStepOutcome> {
  const dispatch = await readDispatch(inputs)
  if (!dispatch.options.agent || dispatch.risky.length === 0) {
    throw new FixRunnerError('The dispatch hands no major upgrade to an agent')
  }
  const preset = presetOf(dispatch, inputs, deps.presets ?? AGENT_PRESETS)
  const git = createGit(deps.exec, deps.fs.root)
  const baseSha = await git.headSha()
  const dirty = await git.changedFiles()
  if (dirty.length > 0) {
    throw new FixRunnerError(`The checkout has local changes: ${dirty.slice(0, 5).join(', ')}`)
  }

  const run = await agentRun(preset, dispatch, inputs, deps, baseSha)
  const summary = run.reading?.summary ? truncateCheckOutput(run.reading.summary).output : null
  const captured = run.captured
  const result = parseFixResult({
    schema: FIX_RESULT_SCHEMA,
    runId: dispatch.runId,
    planScanRunId: dispatch.plan.scanRunId,
    repo: dispatch.repo.fullName,
    baseSha,
    packageManager: dispatch.risky[0]?.packageManager ?? 'unknown',
    packageManagerVersion: null,
    checksMode: dispatch.options.checks,
    steps: handedSteps(dispatch, captured?.files ?? []),
    releaseAge: [],
    install: { status: 'skipped', durationMs: 0, output: null, truncated: false },
    checks: [],
    patch:
      captured?.text && captured.sha256
        ? {
            sha256: captured.sha256,
            files: captured.files,
            insertions: captured.insertions,
            deletions: captured.deletions,
          }
        : null,
    agent: {
      preset: preset.name,
      outcome: run.outcome,
      detail: run.detail ? run.detail.slice(0, 500) : null,
      summary: summary === '' ? null : summary,
      durationMs: run.durationMs,
      turns: run.reading?.turns ?? null,
      costUsd: run.reading?.costUsd ?? null,
      refusedPaths: run.refused.slice(0, 200).map((path) => path.slice(0, 512)),
    },
    finishedAt: deps.now().toISOString(),
  })
  return { dispatch, result, patch: captured?.text ?? null }
}
