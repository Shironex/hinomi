import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIX_DISPATCH_SCHEMA, type FixDispatchStep, type FixDispatchV1 } from '@hinomi/shared'
import { formatLog, type Logger } from './actions-io.js'
import { nodeExec, type Command, type Exec, type ExecResult } from './exec.js'
import type { PublishTimes } from './registry.js'
import type { RunnerDeps } from './pipeline.js'
import { nodeRepoFs } from './repo-fs.js'

// Test harness: fixture repos in a temp folder with a real git history, a fake package
// manager at the exec boundary (git stays real), and a mocked registry. Fictional data only.

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
export const NOW = new Date('2026-11-07T10:00:00.000Z')
export const REPO = 'kestrel-co/shop'
const DAY = 86_400_000

export function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY)
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.dev',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.dev',
}

/** Runs git in a fixture repo with a fixed identity. */
export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, env: GIT_ENV, stdio: 'pipe' }).toString('utf8')
}

/**
 * Copies a fixture into a fresh temp folder and commits it, after `prepare` when given (the
 * real package manager test creates its lockfile there). Returns the folder.
 */
export async function fixtureRepo(
  name: string,
  prepare?: (root: string) => Promise<void>,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `hinomi-runner-${name}-`))
  cpSync(join(FIXTURES, name), root, { recursive: true })
  await prepare?.(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'fixture')
  return root
}

/** Commits every change in a fixture repo, for tests that tweak a fixture first. */
export function commitAll(root: string): void {
  git(root, 'commit', '-q', '-am', 'tweak')
}

export function readText(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

export function readJson(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readText(root, path)) as Record<string, unknown>
}

export interface Call {
  command: Command
  cwd: string
}

export type PmHandler = (call: Call) => Partial<ExecResult> | Promise<Partial<ExecResult>>

/** An Exec that runs git for real and hands every other command to `handler`. */
export function fakeExec(handler: PmHandler): Exec & { calls: Call[] } {
  const git = nodeExec({ env: GIT_ENV })
  const calls: Call[] = []
  return {
    calls,
    async run(command, options) {
      if (command.file === 'git') return git.run(command, options)
      calls.push({ command, cwd: options.cwd })
      const result = await handler({ command, cwd: options.cwd })
      return { code: 0, output: '', timedOut: false, durationMs: 5, ...result }
    },
  }
}

/** A package manager that prints a version and passes everything else. */
export function passingPm(version = '10.34.9'): PmHandler {
  return ({ command }) => (command.args[0] === '--version' ? { output: `${version}\n` } : {})
}

export function argv(call: Call): string {
  return [call.command.file, ...call.command.args].join(' ')
}

export function mockPublishTimes(
  times: Record<string, Date | null>,
): PublishTimes & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    publishedAt(packageName, version, registry) {
      requests.push(`${registry}${packageName}@${version}`)
      return Promise.resolve(times[`${packageName}@${version}`] ?? null)
    },
  }
}

export function silentLogger(lines: string[] = []): Logger {
  return {
    info: (message, fields) => lines.push(formatLog(message, fields)),
    warning: (message, fields) => lines.push(`warning: ${formatLog(message, fields)}`),
    error: (message, fields) => lines.push(`error: ${formatLog(message, fields)}`),
    group: (title, run) => {
      lines.push(`group: ${title}`)
      return run()
    },
  }
}

export function deps(
  root: string,
  exec: Exec,
  publishTimes: PublishTimes,
  lines?: string[],
): RunnerDeps {
  return { fs: nodeRepoFs(root), exec, publishTimes, log: silentLogger(lines), now: () => NOW }
}

type StepInput = Partial<FixDispatchStep> & Pick<FixDispatchStep, 'packageName' | 'to' | 'apply'>

export function step(order: number, input: StepInput): FixDispatchStep {
  const lockfile = input.lockfile ?? 'pnpm-lock.yaml'
  return {
    id: `${input.apply.type}:npm:${input.packageName}:${input.to}:${lockfile}`,
    order,
    tier: 'exposed',
    ecosystem: 'npm',
    relationship: input.apply.type === 'override' ? 'transitive' : 'direct',
    lockfile,
    packageManager: 'pnpm',
    workspaces: [],
    from: ['1.2.0'],
    level: 'minor',
    advisories: ['GHSA-aaaa-bbbb-cccc'],
    releasedAt: null,
    releaseAge: 'unknown',
    ...input,
  }
}

export function dispatch(
  steps: FixDispatchStep[],
  options: Partial<FixDispatchV1['options']> = {},
): FixDispatchV1 {
  return {
    schema: FIX_DISPATCH_SCHEMA,
    runId: 'run-7',
    dispatchedAt: NOW.toISOString(),
    plan: { version: 1, scanRunId: 41, createdAt: '2026-11-07T09:00:00.000Z' },
    repo: { id: 3, fullName: REPO, baseBranch: 'main' },
    steps,
    risky: [],
    omitted: { steps: 0, risky: 0, advisories: false },
    options: { checks: 'full', agent: false, linksAllowed: false, releaseAgeDays: 7, ...options },
  }
}

/** Apply inputs for a dispatch sent as plain JSON. */
export function inputs(value: FixDispatchV1, checks = 'auto') {
  return {
    plan: JSON.stringify(value),
    encoding: 'json',
    runId: value.runId,
    repository: REPO,
    checks,
  }
}
