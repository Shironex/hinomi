import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { currentTime, type FixPayloadCompressor } from '@hinomi/shared'
import type { Repositories } from '../repository/index.js'
import { MAX_RESULT_FILE_BYTES } from './artifact.js'
import { finishDispatch, isRefusal, prepareDispatch, type PreparedDispatch } from './dispatch.js'
import type { RunnerGithub } from './github.js'
import {
  nodeProcessRunner,
  scrubSecrets,
  type ProcessResult,
  type ProcessRunner,
} from './local-process.js'
import { applyRunReport, cleanReason, type RunReport } from './report.js'
import type { FixRunDispatchOutcome, FixRunDispatchRequest, FixRunner } from './runner.js'
import { BEFORE_PUSH } from './tracking.js'

// The local runner (docs/design/fix-runner.md section 21.3): the fix plan is applied on the
// Hinomi host by the bundled fix runner action, the same code the GitHub workflow runs, in a
// fresh clone under the data folder. Steps: clone, apply (lockfile only installs), optionally the
// check step, then publish from a second clean clone of the base commit, which verifies the
// patch and pushes the fix branch. The outcome goes through applyRunReport like a webhook
// callback, and Hinomi's publisher opens the PR.

const MINUTE = 60_000

/** Longest each child may run before its process group is killed. */
export const LOCAL_STEP_TIMEOUTS_MS = {
  clone: 5 * MINUTE,
  apply: 20 * MINUTE,
  check: 20 * MINUTE,
  publish: 5 * MINUTE,
} as const

/** Largest patch copied out of the checkout; publish checks its hash against the apply step. */
export const LOCAL_PATCH_MAX_BYTES = 16 * 1024 * 1024

/** The folder under HINOMI_DATA_DIR that holds one subfolder per local run. */
export const LOCAL_RUNNER_DIR = 'runner'

const RESULT_FILE = 'hinomi-result.json'
const PATCH_FILE = 'fix.patch'
/** The action's output folder inside the checkout. */
const ACTION_OUTPUT_DIR = '.hinomi'

export const LOCAL_MAJORS_UNSUPPORTED =
  'The local runner does not run the majors agent. Use the GitHub Actions or the webhook runner for major upgrades.'
const LOCAL_BUSY = 'A local run is already in progress on this host. Dispatch again when it ends.'

/** The few log calls the local runner makes; the server's logger fits. */
export interface LocalRunnerLog {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

export interface LocalRunnerOptions {
  repositories: Repositories
  github: () => RunnerGithub
  /** HINOMI_LOCAL_RUNNER. Off: the kind cannot be chosen and nothing is spawned. */
  enabled: boolean
  /** HINOMI_LOCAL_RUNNER_CHECKS: also run install scripts and checks on the host. */
  checks: boolean
  /** HINOMI_DATA_DIR; runs work in `<dataDir>/runner/<run id>`. */
  dataDir: string
  /** The bundled action, actions/fix-runner/dist/index.mjs. */
  actionEntry: string
  /** The Node binary that runs the action. */
  nodePath?: string
  /** PATH handed to every child, so git and the package managers resolve. */
  hostPath: string
  processes?: ProcessRunner
  /** Whether git can be started. Checked once. */
  gitAvailable?: () => boolean
  platform?: NodeJS.Platform
  /** A run reached `branch_pushed`: poll it now so the PR opens without waiting. */
  onBranchPushed?: (runId: number) => void
  log?: LocalRunnerLog
  compressor?: FixPayloadCompressor
  now?: () => Date
  correlationId?: () => string
  /** Wait before asking GitHub about the pushed branch again. */
  retryDelayMs?: number
}

/** A failure with a message fit for the run page. */
class LocalStepError extends Error {}

/** Whether the local runner can take a dispatch on this host. */
export interface LocalRunnerAvailability {
  available: boolean
  message: string
}

/** The git web origin for a GitHub API root: github.com, or the Enterprise host. */
export function gitOrigin(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl)
  if (url.hostname === 'api.github.com') return 'https://github.com'
  return url.origin
}

/** Parses a GITHUB_OUTPUT file: `name<<delimiter`, the value lines, then the delimiter. */
export function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {}
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_]+)<<(.+)$/.exec(lines[index] ?? '')
    if (!match) continue
    const [, name = '', delimiter] = match
    const value: string[] = []
    index += 1
    while (index < lines.length && lines[index] !== delimiter) {
      value.push(lines[index] ?? '')
      index += 1
    }
    outputs[name] = value.join('\n')
  }
  return outputs
}

/** The line that says why a step failed: the last `::error::`, or the last line at all. */
function failureLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('::group::') && line !== '::endgroup::')
  const errors = lines.filter((line) => line.startsWith('::error::'))
  const last = errors.at(-1)?.slice('::error::'.length) ?? lines.at(-1) ?? 'no output'
  // Undoes the action's workflow command escaping; only the first line is kept.
  const text = last.replace(/%0D/g, '').replace(/%0A/g, '\n').replace(/%25/g, '%')
  return text.split('\n')[0] ?? ''
}

function defaultGitAvailable(): boolean {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000 })
  return probe.status === 0
}

/** Copies a regular file (never a link the repo planted) of at most `maxBytes`. */
async function copyOut(from: string, to: string, maxBytes: number): Promise<boolean> {
  const stats = await lstat(from).catch(() => null)
  if (!stats) return false
  if (!stats.isFile()) throw new LocalStepError(`${basename(from)} is not a file`)
  if (stats.size > maxBytes) {
    throw new LocalStepError(`The runner wrote a file larger than ${maxBytes} bytes`)
  }
  await copyFile(from, to)
  return true
}

interface RunDirs {
  work: string
  apply: string
  publish: string
  out: string
  home: string
  tmp: string
}

export class LocalRunner implements FixRunner {
  readonly kind = 'local' as const
  readonly #options: LocalRunnerOptions
  readonly #processes: ProcessRunner
  readonly #root: string
  #git: boolean | null = null
  #busy = false
  #current: Promise<void> | null = null

  constructor(options: LocalRunnerOptions) {
    this.#options = options
    this.#processes = options.processes ?? nodeProcessRunner()
    this.#root = join(options.dataDir, LOCAL_RUNNER_DIR)
  }

  availability(): LocalRunnerAvailability {
    const { enabled, actionEntry, checks } = this.#options
    if (!enabled) {
      return {
        available: false,
        message: "Set HINOMI_LOCAL_RUNNER=1 in Hinomi's environment to allow the local runner.",
      }
    }
    if ((this.#options.platform ?? process.platform) === 'win32') {
      return { available: false, message: 'The local runner needs Linux or macOS.' }
    }
    if (!existsSync(actionEntry)) {
      return {
        available: false,
        message: 'The bundled fix runner action (actions/fix-runner/dist) is missing.',
      }
    }
    this.#git ??= (this.#options.gitAvailable ?? defaultGitAvailable)()
    if (!this.#git) {
      return {
        available: false,
        message: 'git is not on the PATH of the Hinomi process (see docs/runners.md).',
      }
    }
    return {
      available: true,
      message: checks
        ? 'The local runner is on. It runs install scripts and checks on this host.'
        : 'The local runner is on. Install scripts and checks are left to the PR checks.',
    }
  }

  /**
   * Removes what a run left behind and fails runs a restart cut short. Called once on boot,
   * before any dispatch.
   */
  async recover(): Promise<number> {
    await rm(this.#root, { recursive: true, force: true })
    const now = this.#options.now ?? currentTime
    let failed = 0
    for (const run of this.#options.repositories.fixRuns.listActive()) {
      if (run.runner !== 'local' || !BEFORE_PUSH.includes(run.state)) continue
      const reason = 'Hinomi restarted while the local runner was working on this run.'
      const moved = this.#options.repositories.fixRuns.applyEvent(
        run.id,
        { type: 'failed', reason },
        now(),
      )
      if (moved.ok && moved.changed) failed += 1
    }
    return failed
  }

  async dispatch(request: FixRunDispatchRequest): Promise<FixRunDispatchOutcome> {
    const { available, message } = this.availability()
    if (!available) return { created: false, code: 'not_configured', message }
    if ((request.kind ?? 'fix') === 'majors') {
      return { created: false, code: 'not_configured', message: LOCAL_MAJORS_UNSUPPORTED }
    }
    if (this.#busy) return { created: false, code: 'busy', message: LOCAL_BUSY }
    this.#busy = true
    let prepared: Awaited<ReturnType<typeof prepareDispatch>>
    try {
      prepared = await prepareDispatch(this.#options, this.kind, request)
    } catch (error) {
      this.#busy = false
      throw error
    }
    if (isRefusal(prepared)) {
      this.#busy = false
      return prepared
    }
    const now = this.#options.now ?? currentTime
    const created = finishDispatch(this.#options.repositories, prepared, { accepted: true }, now())
    this.#current = this.#execute(prepared).finally(() => {
      this.#busy = false
      this.#current = null
    })
    return created
  }

  /** The run in progress, for tests and shutdown. Resolves at once when there is none. */
  idle(): Promise<void> {
    return this.#current ?? Promise.resolve()
  }

  /** Kills the running children; the run then fails and its folder is removed. */
  async close(): Promise<void> {
    this.#processes.killAll()
    await this.idle()
  }

  async #execute(prepared: PreparedDispatch): Promise<void> {
    const work = join(this.#root, prepared.correlationId)
    const secrets = new Set<string>()
    const log = this.#options.log
    try {
      await this.#report(prepared, { status: 'running' })
      const report = await this.#steps(prepared, work, secrets)
      await this.#report(prepared, report)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const reason =
        error instanceof LocalStepError ? detail : `The local runner failed unexpectedly: ${detail}`
      log?.warn('local runner: run failed', {
        runId: prepared.run.id,
        reason: scrubSecrets(reason, secrets),
      })
      await this.#report(prepared, { status: 'failed', reason: scrubSecrets(reason, secrets) })
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async #report(prepared: PreparedDispatch, report: RunReport): Promise<void> {
    const { repositories, github } = this.#options
    const now = this.#options.now ?? currentTime
    const context = { repositories, github, now }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = repositories.fixRuns.getByCorrelationId(prepared.correlationId)
      if (!run) return
      const outcome = await applyRunReport(context, run, report)
      if ('run' in outcome) {
        if (outcome.run.state === 'branch_pushed') this.#options.onBranchPushed?.(outcome.run.id)
        return
      }
      if (outcome.kind !== 'unavailable') {
        // A report the run cannot take: record why instead of leaving the run waiting.
        this.#options.log?.warn('local runner: report refused', {
          runId: run.id,
          kind: outcome.kind,
          message: outcome.message,
        })
        if (report.status !== 'failed') {
          await this.#report(prepared, { status: 'failed', reason: cleanReason(outcome.message) })
        }
        return
      }
      if (attempt === 2) {
        await this.#report(prepared, { status: 'failed', reason: cleanReason(outcome.message) })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, this.#options.retryDelayMs ?? 10_000))
    }
  }

  /** The environment of every child, built from nothing. */
  #baseEnv(dirs: RunDirs): Record<string, string> {
    return {
      PATH: this.#options.hostPath,
      HOME: dirs.home,
      TMPDIR: dirs.tmp,
      LANG: 'C.UTF-8',
      CI: 'true',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    }
  }

  async #run(
    label: string,
    spec: { file: string; args: string[]; cwd: string; env: Record<string, string> },
    timeoutMs: number,
    secrets: Set<string>,
  ): Promise<ProcessResult> {
    const result = await this.#processes.run({ ...spec, timeoutMs })
    const output = scrubSecrets(result.output, secrets)
    if (result.timedOut) {
      throw new LocalStepError(
        `The local runner's ${label} step ran past ${Math.round(timeoutMs / MINUTE)} minutes and was stopped.`,
      )
    }
    if (result.code !== 0) {
      this.#options.log?.warn('local runner: step failed', {
        step: label,
        output: output.slice(-2000),
      })
      throw new LocalStepError(`The local runner's ${label} step failed: ${failureLine(output)}`)
    }
    return { ...result, output }
  }

  /** git with the token in its environment config, never in argv or .git/config. */
  async #gitWithToken(
    label: string,
    dirs: RunDirs,
    cwd: string,
    args: string[],
    origin: string,
    token: string,
    secrets: Set<string>,
  ): Promise<void> {
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
    await this.#run(
      label,
      {
        file: 'git',
        args: ['-c', 'core.hooksPath=/dev/null', ...args],
        cwd,
        env: {
          ...this.#baseEnv(dirs),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
        },
      },
      LOCAL_STEP_TIMEOUTS_MS.clone,
      secrets,
    )
  }

  /** Runs one step of the bundled action, as GitHub would, and returns its outputs. */
  async #action(
    step: 'apply' | 'check' | 'publish',
    dirs: RunDirs,
    cwd: string,
    context: { repository: string; serverUrl: string },
    inputs: Record<string, string>,
    secrets: Set<string>,
  ): Promise<Record<string, string>> {
    const outputFile = join(dirs.out, `${step}.outputs`)
    const env: Record<string, string> = {
      ...this.#baseEnv(dirs),
      GITHUB_WORKSPACE: cwd,
      GITHUB_REPOSITORY: context.repository,
      GITHUB_SERVER_URL: context.serverUrl,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: dirs.tmp,
      INPUT_STEP: step,
    }
    for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value
    await this.#run(
      step,
      {
        file: this.#options.nodePath ?? process.execPath,
        args: [this.#options.actionEntry],
        cwd,
        env,
      },
      LOCAL_STEP_TIMEOUTS_MS[step],
      secrets,
    )
    const text = await readFile(outputFile, 'utf8').catch(() => '')
    return parseOutputs(text)
  }

  async #steps(prepared: PreparedDispatch, work: string, secrets: Set<string>): Promise<RunReport> {
    const dirs: RunDirs = {
      work,
      apply: join(work, 'apply'),
      publish: join(work, 'publish'),
      out: join(work, 'out'),
      home: join(work, 'home'),
      tmp: join(work, 'tmp'),
    }
    if (!/^[A-Za-z0-9-]{1,100}$/.test(prepared.correlationId)) {
      throw new LocalStepError('The run id is not safe to use as a folder name.')
    }
    await rm(work, { recursive: true, force: true })
    for (const dir of [dirs.apply, dirs.publish, dirs.out, dirs.home, dirs.tmp]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    }
    const { source, meta, correlationId, encoded } = prepared
    const origin = gitOrigin(source.client.baseUrl)
    const repoUrl = `${origin}/${meta.fullName}.git`
    const context = { repository: meta.fullName, serverUrl: origin }

    const cloneToken = await source.getToken()
    if (cloneToken === '')
      throw new LocalStepError('The GitHub source gave no token to clone with.')
    secrets.add(cloneToken)
    await this.#gitWithToken(
      'clone',
      dirs,
      work,
      [
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--no-tags',
        '--single-branch',
        '--branch',
        meta.defaultBranch,
        repoUrl,
        dirs.apply,
      ],
      origin,
      cloneToken,
      secrets,
    )

    const dispatchInputs = {
      plan: encoded.payload,
      encoding: encoded.encoding,
      run_id: correlationId,
      checks: 'auto',
    }
    const applied = await this.#action(
      'apply',
      dirs,
      dirs.apply,
      context,
      { ...dispatchInputs, defer_checks: 'true' },
      secrets,
    )
    const actionOut = join(dirs.apply, ACTION_OUTPUT_DIR)
    const resultPath = join(dirs.out, RESULT_FILE)
    if (!(await copyOut(join(actionOut, RESULT_FILE), resultPath, MAX_RESULT_FILE_BYTES))) {
      throw new LocalStepError(`The apply step wrote no ${RESULT_FILE}.`)
    }
    const hasChanges = applied.has_changes === 'true'
    if (hasChanges) {
      const copied = await copyOut(
        join(actionOut, PATCH_FILE),
        join(dirs.out, PATCH_FILE),
        LOCAL_PATCH_MAX_BYTES,
      )
      if (!copied) throw new LocalStepError(`The apply step wrote no ${PATCH_FILE}.`)
    }

    if (hasChanges && this.#options.checks) {
      await this.#action('check', dirs, dirs.apply, context, dispatchInputs, secrets)
      // Only the result comes back: the patch stays the one the apply step hashed.
      await copyOut(join(actionOut, RESULT_FILE), resultPath, MAX_RESULT_FILE_BYTES)
    }
    const result: unknown = JSON.parse(await readFile(resultPath, 'utf8'))
    if (!hasChanges) return { status: 'completed', result }

    const baseSha = applied.base_sha ?? ''
    if (!/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new LocalStepError('The apply step reported no base commit.')
    }
    await this.#run(
      'publish checkout',
      {
        file: 'git',
        args: ['-c', 'init.defaultBranch=main', 'init', '--quiet', dirs.publish],
        cwd: work,
        env: this.#baseEnv(dirs),
      },
      LOCAL_STEP_TIMEOUTS_MS.clone,
      secrets,
    )
    await this.#gitWithToken(
      'publish checkout',
      dirs,
      dirs.publish,
      ['fetch', '--quiet', '--depth', '1', '--no-tags', repoUrl, baseSha],
      origin,
      cloneToken,
      secrets,
    )
    await this.#run(
      'publish checkout',
      {
        file: 'git',
        args: ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
        cwd: dirs.publish,
        env: this.#baseEnv(dirs),
      },
      LOCAL_STEP_TIMEOUTS_MS.clone,
      secrets,
    )

    // Asked again: an App token minted before a long apply may be close to its hour.
    const pushToken = await source.getToken()
    if (pushToken === '') throw new LocalStepError('The GitHub source gave no token to push with.')
    secrets.add(pushToken)
    const published = await this.#action(
      'publish',
      dirs,
      dirs.publish,
      context,
      {
        scope: 'fix',
        run_id: correlationId,
        artifact_dir: dirs.out,
        base_sha: baseSha,
        patch_sha256: applied.patch_sha256 ?? '',
        patch_files: applied.patch_files ?? '[]',
        token: pushToken,
      },
      secrets,
    )
    const headSha = published.commit_sha ?? ''
    if (published.pushed !== 'true' || !/^[0-9a-f]{40}$/.test(headSha)) {
      throw new LocalStepError('The publish step pushed no commit.')
    }
    this.#options.log?.info('local runner: branch pushed', { runId: prepared.run.id, headSha })
    return { status: 'completed', result, headSha }
  }
}
