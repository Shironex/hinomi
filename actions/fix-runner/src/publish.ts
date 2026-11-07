import { createHash } from 'node:crypto'
import { FIX_BRANCH, MAJORS_BRANCH, type FixResultV1 } from '@hinomi/shared'
import type { Logger } from './actions-io.js'
import { FixRunnerError } from './errors.js'
import type { Command, Exec } from './exec.js'
import {
  MAJORS_PATCH_MAX_BYTES,
  MAJORS_PATCH_MAX_FILES,
  isAllowedMajorsPatchPath,
  isAllowedPatchPath,
} from './patch.js'
import type { FixScope } from './pipeline.js'

// The publish job: the only code that holds a write token. It trusts nothing from the
// artifact on its own: the patch must hash to the SHA-256 the apply step reported as a job
// output (set before any install script ran), touch exactly the files that step listed, pass
// the dependency file allowlist again, and contain no renames, deletions, mode changes or
// symlinks. Then it applies the patch on the base commit, commits it as github-actions[bot]
// and force pushes the fix branch. It never opens the PR; Hinomi does.
//
// With scope `majors` it publishes the coding agent's patch instead: the same hash and file
// list pinning, a wider allowlist (any text file outside .github and the other execution
// sinks in patch.ts), no binary data, at most MAJORS_PATCH_MAX_FILES files and
// MAJORS_PATCH_MAX_BYTES bytes, pushed to hinomi/majors.

const GIT_TIMEOUT_MS = 120_000
const SHA256 = /^[a-f0-9]{64}$/
const COMMIT_SHA = /^[a-f0-9]{40}$/
const REGULAR_MODES = new Set(['100644', '100755'])
const BOT_NAME = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

/** Header lines a fix patch never needs; any of them refuses the whole patch. */
const REFUSED_HEADERS = [
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'similarity index ',
  'dissimilarity index ',
  'old mode ',
  'new mode ',
  'deleted file mode ',
]

function refuse(message: string): never {
  throw new FixRunnerError(`Refusing the patch: ${message}`)
}

/**
 * The files a `git diff` patch touches, checked line by line: one plain path per file (no
 * quotes or spaces), the same on both sides, regular file modes only, nothing renamed,
 * copied, deleted or re-moded.
 */
export function parsePatchPaths(text: string): string[] {
  const paths: string[] = []
  let current: string | null = null
  // Past the `+++` line or `GIT binary patch`, every line is hunk or binary data until the
  // next file; hunk lines always start with a space, `+`, `-`, `@` or a backslash.
  let inBody = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inBody = false
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line)
      if (!match?.[1] || match[1] !== match[2]) refuse(`unexpected file header ${line}`)
      current = match[1]
      if (paths.includes(current)) refuse(`${current} appears twice`)
      paths.push(current)
      continue
    }
    if (current === null) {
      if (line.trim() !== '') refuse('text before the first file')
      continue
    }
    if (inBody) continue
    if (line === 'GIT binary patch') {
      inBody = true
      continue
    }
    if (REFUSED_HEADERS.some((prefix) => line.startsWith(prefix))) {
      refuse(`${current}: ${line}`)
    }
    if (line.startsWith('new file mode ')) {
      if (!REGULAR_MODES.has(line.slice('new file mode '.length))) refuse(`${current}: ${line}`)
      continue
    }
    const index = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/.exec(line)
    if (index) {
      if (index[1] !== undefined && !REGULAR_MODES.has(index[1])) refuse(`${current}: ${line}`)
      continue
    }
    if (line.startsWith('--- ') && line !== `--- a/${current}` && line !== '--- /dev/null') {
      refuse(`${current}: ${line}`)
    }
    if (line.startsWith('+++ ')) {
      if (line !== `+++ b/${current}`) refuse(`${current}: ${line}`)
      inBody = true
      continue
    }
    if (line.startsWith('Binary files ')) refuse(`${current}: a binary change without its data`)
  }
  if (paths.length === 0) refuse('it changes no file')
  return paths
}

export interface PublishCheckInput {
  patch: Buffer
  result: FixResultV1
  /** From the apply job's outputs. */
  expectedSha256: string
  expectedFiles: string[]
  baseSha: string
  /** `github.repository` and the run_id input of this run. */
  repository: string
  runId: string
  /** Which job made the patch. Default `fix`. */
  scope?: FixScope
}

/** The branch a scope publishes to. */
export function branchFor(scope: FixScope): string {
  return scope === 'majors' ? MAJORS_BRANCH : FIX_BRANCH
}

function verifyMajors(patch: Buffer, result: FixResultV1, paths: string[]): void {
  if (!result.agent) refuse('a majors patch needs the agent report in hinomi-result.json')
  if (patch.length > MAJORS_PATCH_MAX_BYTES) {
    refuse(`it is ${patch.length} bytes, more than ${MAJORS_PATCH_MAX_BYTES}`)
  }
  if (paths.length > MAJORS_PATCH_MAX_FILES) {
    refuse(`it touches ${paths.length} files, more than ${MAJORS_PATCH_MAX_FILES}`)
  }
  if (patch.toString('utf8').split('\n').includes('GIT binary patch')) {
    refuse('a majors patch carries no binary data')
  }
  for (const path of paths) {
    if (!isAllowedMajorsPatchPath(path)) refuse(`${path} is outside what a majors patch may change`)
  }
}

/** Every check before the patch is applied. Returns the patch's files. Throws on any doubt. */
export function verifyPublish(input: PublishCheckInput): string[] {
  const { result } = input
  if (!SHA256.test(input.expectedSha256)) refuse('the apply job reported no patch hash')
  if (!COMMIT_SHA.test(input.baseSha)) refuse('the apply job reported no base commit')
  if (result.repo.toLowerCase() !== input.repository.toLowerCase()) {
    refuse(`the result is for ${result.repo}, this run is in ${input.repository}`)
  }
  if (input.runId !== '' && result.runId !== input.runId) {
    refuse(`the result is for run ${result.runId}, not ${input.runId}`)
  }
  if (result.baseSha !== input.baseSha) refuse('the result names another base commit')
  const sha256 = createHash('sha256').update(input.patch).digest('hex')
  if (sha256 !== input.expectedSha256) refuse('its SHA-256 differs from the apply job output')
  if (result.patch?.sha256 !== sha256) refuse('its SHA-256 differs from hinomi-result.json')
  const expected = [...input.expectedFiles].sort()
  const paths = parsePatchPaths(input.patch.toString('utf8')).sort()
  if (paths.join('\n') !== expected.join('\n')) {
    refuse(`it touches ${paths.join(', ')} but the apply job listed ${expected.join(', ')}`)
  }
  if ((input.scope ?? 'fix') === 'majors') {
    verifyMajors(input.patch, result, paths)
    return paths
  }
  if (result.agent) refuse('the result is from a majors run, not a fix run')
  const listed = new Set(expected)
  for (const path of paths) {
    if (!isAllowedPatchPath(path, listed)) refuse(`${path} is not a dependency file`)
  }
  return paths
}

export interface PublishOptions {
  exec: Exec
  log: Logger
  /** Absolute path of the fresh checkout of the base commit. */
  root: string
  /** Absolute path of fix.patch. */
  patchPath: string
  paths: string[]
  result: FixResultV1
  baseSha: string
  dryRun: boolean
  /** Required unless dryRun. */
  token: string
  /** `github.server_url` and `github.repository`, to build the push URL. */
  serverUrl: string
  repository: string
  /** Writes a line to the job log; used to mask the push credential. */
  write: (line: string) => void
  /** Which job made the patch. Default `fix`. */
  scope?: FixScope
}

export interface PublishOutcome {
  branch: string
  commitSha: string
  pushed: boolean
}

/** The commit message of the fix or majors branch, from the result. */
export function commitMessage(result: FixResultV1): string {
  if (result.agent) {
    const packages = result.steps.length
    return [
      `fix(deps): adapt to major upgrades from hinomi run ${result.runId}`,
      '',
      `Hinomi majors run ${result.runId}, plan ${result.planScanRunId}: ${packages} major ${packages === 1 ? 'upgrade' : 'upgrades'}.`,
      `A coding agent (${result.agent.preset}) wrote these changes; review them before merging.`,
      '',
    ].join('\n')
  }
  const applied = result.steps.filter((step) => step.status === 'applied').length
  return [
    `fix(deps): apply hinomi fix plan ${result.planScanRunId}`,
    '',
    `Hinomi fix run ${result.runId}: ${applied} of ${result.steps.length} steps applied.`,
    '',
  ].join('\n')
}

/** Applies the verified patch on the base commit, commits it and pushes the fix branch. */
export async function publishPatch(options: PublishOptions): Promise<PublishOutcome> {
  const { exec, root, log } = options
  const branch = branchFor(options.scope ?? 'fix')
  const git = async (args: string[], env?: Record<string, string>) => {
    const command: Command = {
      file: 'git',
      args: ['-c', 'core.quotepath=off', '-c', 'core.hooksPath=/dev/null', '--no-pager', ...args],
      ...(env && { env }),
    }
    const result = await exec.run(command, { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new FixRunnerError(`git ${args[0] ?? ''} failed: ${result.output.trim().slice(-500)}`)
    }
    return result.output
  }

  const head = (await git(['rev-parse', 'HEAD'])).trim()
  if (head !== options.baseSha) {
    throw new FixRunnerError(`The checkout is at ${head}, the patch is for ${options.baseSha}`)
  }
  if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim() !== '') {
    throw new FixRunnerError('The publish checkout has local changes')
  }
  await git(['apply', '--check', '--whitespace=nowarn', options.patchPath])
  await git(['apply', '--index', '--whitespace=nowarn', options.patchPath])
  const staged = (await git(['diff', '--cached', '--name-only', '-z', '--no-renames']))
    .split('\0')
    .filter((path) => path !== '')
    .sort()
  if (staged.join('\n') !== [...options.paths].sort().join('\n')) {
    throw new FixRunnerError(`Applying the patch staged ${staged.join(', ')}`)
  }
  const identity = {
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  }
  await git(
    ['commit', '--no-verify', '--no-gpg-sign', '--quiet', '-m', commitMessage(options.result)],
    identity,
  )
  const commitSha = (await git(['rev-parse', 'HEAD'])).trim()
  log.info('committed', { commit: commitSha, files: staged.join(',') })
  if (options.dryRun) {
    log.info('dry run, nothing pushed', { branch })
    return { branch, commitSha, pushed: false }
  }

  if (options.token === '') throw new FixRunnerError('No token to push with')
  const server = new URL(options.serverUrl)
  if (server.protocol !== 'https:') throw new FixRunnerError('The server URL must be https')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new FixRunnerError(`Unexpected repository ${options.repository}`)
  }
  const basic = Buffer.from(`x-access-token:${options.token}`, 'utf8').toString('base64')
  options.write(`::add-mask::${basic}`)
  // The credential travels in git's environment config, never in argv or .git/config.
  await git(
    [
      'push',
      '--force',
      '--no-verify',
      `${server.origin}/${options.repository}.git`,
      `HEAD:refs/heads/${branch}`,
    ],
    {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${server.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
  )
  log.info('pushed', { branch, commit: commitSha })
  return { branch, commitSha, pushed: true }
}
