import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FixPayloadError, currentTime, parseFixResult } from '@hinomi/shared'
import { consoleLogger, getInput, writeOutputs, type Env } from './actions-io.js'
import { RESULT_FILE, writeArtifacts, writeResult } from './artifacts.js'
import { FixRunnerError } from './errors.js'
import { nodeExec } from './exec.js'
import { runApply, runChecks, runDetect, type DispatchInputs } from './pipeline.js'
import { registryPublishTimes, type HttpFetch } from './registry.js'
import { nodeRepoFs } from './repo-fs.js'
import { toolchainOutputs } from './toolchain.js'

// The action entry: reads the inputs, runs the `detect`, `apply` or `check` step and sets
// outputs. The plan reaches this code only through INPUT_PLAN, never through a shell.

/** Folder inside the checkout the workflow uploads, as in the reusable workflow sketch. */
export const OUTPUT_DIR = '.hinomi'

async function readResult(dir: string) {
  const text = await readFile(join(dir, RESULT_FILE), 'utf8').catch(() => null)
  if (text === null) throw new FixRunnerError(`No ${RESULT_FILE} in ${dir}`)
  try {
    return parseFixResult(JSON.parse(text))
  } catch (error) {
    if (error instanceof FixPayloadError) throw error
    throw new FixRunnerError(`${RESULT_FILE} is not JSON`, { cause: error })
  }
}

export interface MainIo {
  env: Env
  write: (line: string) => void
  fetch: HttpFetch
  now?: () => Date
}

/** Runs the action. Returns the process exit code. */
export async function main(io: MainIo): Promise<number> {
  const { env } = io
  const log = consoleLogger(io.write)
  const outputs: Record<string, string> = {}
  const flush = () => {
    if (env.GITHUB_OUTPUT) writeOutputs(env.GITHUB_OUTPUT, outputs)
  }
  try {
    const workspace = resolve(env.GITHUB_WORKSPACE ?? '.')
    const fs = nodeRepoFs(workspace)
    const step = getInput(env, 'step') || 'apply'
    const dispatchInputs: DispatchInputs = {
      plan: getInput(env, 'plan'),
      encoding: getInput(env, 'encoding'),
      runId: getInput(env, 'run_id'),
      repository: env.GITHUB_REPOSITORY ?? '',
    }
    const outputDir = resolve(workspace, OUTPUT_DIR)
    if (step === 'detect') {
      const detected = await runDetect(dispatchInputs, fs)
      for (const problem of detected.problems) log.warning('Detection failed', { problem })
      Object.assign(outputs, {
        package_manager: detected.packageManager,
        package_manager_version: detected.packageManagerVersion,
        lockfile: detected.lockfile,
        project_root: detected.root,
        ...toolchainOutputs(detected.toolchains),
        artifact_name: `hinomi-fix-${detected.dispatch.runId}`,
        agent_needed: String(detected.dispatch.options.agent && detected.dispatch.risky.length > 0),
      })
      flush()
      return 0
    }

    const exec = nodeExec({ env, echo: (chunk) => io.write(chunk.replace(/\n$/, '')) })
    const runnerDeps = {
      fs,
      exec,
      publishTimes: registryPublishTimes(io.fetch),
      log,
      now: io.now ?? currentTime,
    }
    const applyInputs = { ...dispatchInputs, checks: getInput(env, 'checks') }
    if (step === 'check') {
      const result = await runChecks(applyInputs, runnerDeps, await readResult(outputDir))
      await writeResult(outputDir, result)
      const failed = result.checks.filter((check) => check.status !== 'passed').length
      log.info('checks done', { checks: result.checks.length, failed })
      flush()
      return 0
    }
    if (step !== 'apply') throw new FixRunnerError(`Unknown step ${JSON.stringify(step)}`)

    const outcome = await runApply(
      { ...applyInputs, deferChecks: getInput(env, 'defer_checks') === 'true' },
      runnerDeps,
    )
    const written = await writeArtifacts(outputDir, outcome.result, outcome.patch)
    const applied = outcome.result.steps.filter((s) => s.status === 'applied').length
    log.info('done', {
      applied,
      steps: outcome.result.steps.length,
      patch: outcome.result.patch ? outcome.result.patch.files.join(',') : 'none',
    })
    Object.assign(outputs, {
      has_changes: String(outcome.patch !== null),
      agent_needed: String(outcome.dispatch.options.agent && outcome.dispatch.risky.length > 0),
      result_path: written.resultPath,
      patch_path: written.patchPath ?? '',
      output_dir: outputDir,
      package_manager: outcome.result.packageManager,
    })
    flush()
    return 0
  } catch (error) {
    const known = error instanceof FixPayloadError || error instanceof FixRunnerError
    const message = error instanceof Error ? error.message : String(error)
    log.error(known ? message : 'Unexpected failure', known ? undefined : { error: message })
    outputs.has_changes = 'false'
    outputs.rejected = String(known)
    flush()
    return 1
  }
}
