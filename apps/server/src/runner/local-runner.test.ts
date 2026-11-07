import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import type { FixPlanRow, RepoRow } from '../db/schema.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { openRunnerGithub } from './github.js'
import type { ProcessResult, ProcessRunner, ProcessSpec } from './local-process.js'
import { scrubSecrets } from './local-process.js'
import {
  LOCAL_MAJORS_UNSUPPORTED,
  LocalRunner,
  gitOrigin,
  parseOutputs,
  type LocalRunnerOptions,
} from './local-runner.js'
import {
  connectGithubToken,
  fakeGithub,
  repoReply,
  runnerResult,
  saveRunnerPlan,
  type FakeReply,
} from './testing.js'

// The local runner against a fake process runner that plays git and the bundled action, and a
// fake GitHub. Nothing is spawned. Every repo, path and token here is fictional.

const T0 = new Date('2026-11-07T10:00:00.000Z')
const RUN_ID = 'run-local-5e21'
const TOKEN = 'github_pat_fictional0000000000000000'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64')
const BASE = 'a'.repeat(40)
const HEAD = 'c'.repeat(40)
const BRANCH = '/repos/kestrel-co/harbor/branches/hinomi%2Ffix-plan'
const ENTRY = '/opt/hinomi/actions/fix-runner/dist/index.mjs'

let repos: Repositories
let handle: DatabaseHandle
let harbor: RepoRow
let plan: FixPlanRow
let dataDir: string

beforeEach(async () => {
  const test = createTestRepositories()
  repos = test.repos
  handle = test.handle
  harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor', defaultBranch: 'main' })
  connectGithubToken(repos, TOKEN)
  plan = saveRunnerPlan(repos, harbor, T0)
  dataDir = await mkdtemp(join(tmpdir(), 'hinomi-local-'))
})
afterEach(async () => {
  handle.close()
  await rm(dataDir, { recursive: true, force: true })
})

type StepAnswer = Partial<ProcessResult> & { outputs?: Record<string, string> }

function outputsText(outputs: Record<string, string>): string {
  return Object.entries(outputs)
    .map(([name, value]) => `${name}<<hinomi_end\n${value}\nhinomi_end\n`)
    .join('')
}

/**
 * Plays the children: git succeeds, the action's apply step writes a result and a patch, the
 * publish step reports a pushed commit. `answers` replaces what a step does, by label.
 */
function fakeProcesses(answers: Record<string, StepAnswer> = {}, hasChanges = true) {
  const specs: ProcessSpec[] = []
  let killed = 0
  const runner: ProcessRunner = {
    async run(spec) {
      specs.push(spec)
      const step = spec.file === 'git' ? `git ${spec.args[2] ?? ''}` : (spec.env.INPUT_STEP ?? '')
      const answer = answers[step]
      if (step === 'apply' && answer?.code === undefined) {
        const out = join(spec.cwd, '.hinomi')
        await mkdir(out, { recursive: true })
        const result = runnerResult(plan.plan, RUN_ID, { repo: 'Kestrel-Co/Harbor' })
        await writeFile(
          join(out, 'hinomi-result.json'),
          JSON.stringify(hasChanges ? result : { ...result, patch: null }),
        )
        if (hasChanges) await writeFile(join(out, 'fix.patch'), 'diff --git a/package.json\n')
      }
      const outputs =
        answer?.outputs ??
        (step === 'apply'
          ? {
              has_changes: String(hasChanges),
              base_sha: BASE,
              patch_sha256: 'b'.repeat(64),
              patch_files: '["package.json"]',
            }
          : step === 'publish'
            ? { branch: 'hinomi/fix-plan', commit_sha: HEAD, pushed: 'true' }
            : {})
      if (spec.env.GITHUB_OUTPUT) await writeFile(spec.env.GITHUB_OUTPUT, outputsText(outputs))
      return {
        code: answer?.code ?? 0,
        timedOut: answer?.timedOut ?? false,
        output:
          answer?.output ??
          (step === 'publish' ? `::add-mask::${BASIC}\npushed branch=hinomi/fix-plan` : 'ok'),
      }
    },
    killAll() {
      killed += 1
    },
  }
  return { runner, specs, killed: () => killed }
}

function setup(
  options: Partial<LocalRunnerOptions> = {},
  branchReply: FakeReply = { body: { name: 'hinomi/fix-plan', commit: { sha: HEAD } } },
) {
  const github = fakeGithub([
    { path: '/repos/kestrel-co/harbor', reply: repoReply('Kestrel-Co', 'Harbor', 'private') },
    { path: BRANCH, reply: branchReply },
  ])
  const fake = fakeProcesses()
  const pushed: number[] = []
  const warnings: Record<string, unknown>[] = []
  const runner = new LocalRunner({
    repositories: repos,
    github: (repoId) => openRunnerGithub(repos, repoId, { fetch: github.fetch }),
    enabled: true,
    checks: false,
    dataDir,
    actionEntry: import.meta.filename,
    nodePath: '/opt/node/bin/node',
    hostPath: '/usr/bin:/bin',
    processes: fake.runner,
    gitAvailable: () => true,
    platform: 'linux',
    onBranchPushed: (id) => pushed.push(id),
    log: { info() {}, warn: (_message, data) => warnings.push(data ?? {}) },
    now: () => T0,
    correlationId: () => RUN_ID,
    retryDelayMs: 0,
    ...options,
  })
  return { runner, fake, pushed, warnings, requests: github.requests }
}

const ACTION_ENV_KEYS = [
  'CI',
  'GITHUB_OUTPUT',
  'GITHUB_REPOSITORY',
  'GITHUB_SERVER_URL',
  'GITHUB_WORKSPACE',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'HOME',
  'LANG',
  'PATH',
  'RUNNER_TEMP',
  'TMPDIR',
]

describe('LocalRunner.dispatch', () => {
  it('clones, applies, publishes from a clean clone and records the pushed branch', async () => {
    const { runner, fake, pushed } = setup()
    const outcome = await runner.dispatch({ repo: harbor, plan })
    expect(outcome).toMatchObject({ created: true, run: { runner: 'local', state: 'dispatched' } })
    await runner.idle()

    const run = repos.fixRuns.getByCorrelationId(RUN_ID)
    expect(run).toMatchObject({ state: 'branch_pushed', headSha: HEAD })
    expect(pushed).toEqual([run?.id])

    const labels = fake.specs.map((spec) =>
      spec.file === 'git' ? `git ${spec.args[2] ?? ''}` : `action ${spec.env.INPUT_STEP ?? ''}`,
    )
    expect(labels).toEqual([
      'git clone',
      'action apply',
      'git init',
      'git fetch',
      'git checkout',
      'action publish',
    ])
    const [clone, apply, , fetch, , publish] = fake.specs
    expect(clone?.args).toContain('https://github.com/Kestrel-Co/Harbor.git')
    expect(clone?.timeoutMs).toBe(5 * 60_000)
    expect(apply?.timeoutMs).toBe(20 * 60_000)
    expect(publish?.timeoutMs).toBe(5 * 60_000)
    expect(apply?.file).toBe('/opt/node/bin/node')
    expect(apply?.env).toMatchObject({
      INPUT_DEFER_CHECKS: 'true',
      INPUT_RUN_ID: RUN_ID,
      GITHUB_REPOSITORY: 'Kestrel-Co/Harbor',
      GITHUB_SERVER_URL: 'https://github.com',
      PATH: '/usr/bin:/bin',
    })
    expect(fetch?.args).toContain(BASE)
    expect(publish?.env).toMatchObject({
      INPUT_BASE_SHA: BASE,
      INPUT_PATCH_FILES: '["package.json"]',
      INPUT_TOKEN: TOKEN,
      INPUT_SCOPE: 'fix',
    })
    // The token only travels in the environment, and only to git's network calls and publish.
    for (const spec of fake.specs) {
      expect(spec.args.join(' ')).not.toContain(TOKEN)
      expect(spec.args.join(' ')).not.toContain(BASIC)
    }
    expect(clone?.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${BASIC}`)
    expect(clone?.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(JSON.stringify(apply?.env)).not.toContain(TOKEN)
    expect(JSON.stringify(apply?.env)).not.toContain(BASIC)
  })

  it('builds every child environment from nothing', async () => {
    process.env.HINOMI_SECRET_KEY_PROBE = 'must-not-leak'
    try {
      const { runner, fake } = setup()
      await runner.dispatch({ repo: harbor, plan })
      await runner.idle()
      const apply = fake.specs.find((spec) => spec.env.INPUT_STEP === 'apply')
      const keys = Object.keys(apply?.env ?? {}).filter((key) => !key.startsWith('INPUT_'))
      expect(keys.sort()).toEqual(ACTION_ENV_KEYS)
      for (const spec of fake.specs) {
        expect(JSON.stringify(spec.env)).not.toContain('must-not-leak')
        expect(spec.env.HOME).toMatch(new RegExp(`runner/${RUN_ID}/home$`))
        expect(spec.env.TMPDIR).toMatch(new RegExp(`runner/${RUN_ID}/tmp$`))
      }
    } finally {
      delete process.env.HINOMI_SECRET_KEY_PROBE
    }
  })

  it('removes the run folder whatever the outcome', async () => {
    const { runner } = setup()
    await runner.dispatch({ repo: harbor, plan })
    await runner.idle()
    expect(existsSync(join(dataDir, 'runner', RUN_ID))).toBe(false)
  })

  it('records nothing to do and publishes nothing when the plan changed no file', async () => {
    const fake = fakeProcesses({}, false)
    const { runner } = setup({ processes: fake.runner })
    await runner.dispatch({ repo: harbor, plan })
    await runner.idle()
    expect(repos.fixRuns.getByCorrelationId(RUN_ID)?.state).toBe('nothing_to_do')
    expect(fake.specs.map((spec) => spec.env.INPUT_STEP).filter(Boolean)).toEqual(['apply'])
  })

  it('fails the run with the error line and never stores the token', async () => {
    const fake = fakeProcesses({
      apply: {
        code: 1,
        output: `cloning with ${TOKEN}\n::error::Dispatch rejected for ${TOKEN}%0Asecond line`,
      },
    })
    const { runner, warnings } = setup({ processes: fake.runner })
    await runner.dispatch({ repo: harbor, plan })
    await runner.idle()
    const run = repos.fixRuns.getByCorrelationId(RUN_ID)
    expect(run?.state).toBe('failed')
    expect(run?.stateReason).toBe("The local runner's apply step failed: Dispatch rejected for ***")
    expect(JSON.stringify(warnings)).not.toContain(TOKEN)
    expect(existsSync(join(dataDir, 'runner', RUN_ID))).toBe(false)
  })

  it('stops a step that runs too long', async () => {
    const fake = fakeProcesses({ apply: { code: null, timedOut: true } })
    const { runner } = setup({ processes: fake.runner })
    await runner.dispatch({ repo: harbor, plan })
    await runner.idle()
    expect(repos.fixRuns.getByCorrelationId(RUN_ID)?.stateReason).toBe(
      "The local runner's apply step ran past 20 minutes and was stopped.",
    )
    expect(fake.specs.some((spec) => spec.env.INPUT_STEP === 'publish')).toBe(false)
  })

  it('runs the check step only with HINOMI_LOCAL_RUNNER_CHECKS', async () => {
    const { runner, fake } = setup({ checks: true })
    await runner.dispatch({ repo: harbor, plan })
    await runner.idle()
    const steps = fake.specs.map((spec) => spec.env.INPUT_STEP).filter(Boolean)
    expect(steps).toEqual(['apply', 'check', 'publish'])
    expect(fake.specs.find((spec) => spec.env.INPUT_STEP === 'check')?.timeoutMs).toBe(20 * 60_000)
  })

  it('fails the run when the branch on GitHub is not at the pushed commit', async () => {
    const { runner } = setup(
      {},
      { body: { name: 'hinomi/fix-plan', commit: { sha: 'd'.repeat(40) } } },
    )
    await runner.dispatch({ repo: harbor, plan })
    await runner.idle()
    const run = repos.fixRuns.getByCorrelationId(RUN_ID)
    expect(run?.state).toBe('failed')
    expect(run?.stateReason).toContain(`is at ${'d'.repeat(40)} on GitHub`)
  })

  it('takes one run at a time', async () => {
    const { runner } = setup()
    await runner.dispatch({ repo: harbor, plan })
    const second = await runner.dispatch({ repo: harbor, plan })
    expect(second).toMatchObject({ created: false, code: 'busy' })
    await runner.idle()
  })

  it('refuses the majors agent before a run exists', async () => {
    const { runner, fake } = setup()
    const outcome = await runner.dispatch({ repo: harbor, plan, kind: 'majors' })
    expect(outcome).toEqual({
      created: false,
      code: 'not_configured',
      message: LOCAL_MAJORS_UNSUPPORTED,
    })
    expect(fake.specs).toHaveLength(0)
    expect(repos.fixRuns.listActive()).toHaveLength(0)
  })

  it('refuses while HINOMI_LOCAL_RUNNER is off, git is missing or the host is Windows', async () => {
    const cases: [Partial<LocalRunnerOptions>, string][] = [
      [{ enabled: false }, 'HINOMI_LOCAL_RUNNER=1'],
      [{ gitAvailable: () => false }, 'git is not on the PATH'],
      [{ platform: 'win32' }, 'Linux or macOS'],
      [{ actionEntry: ENTRY }, 'actions/fix-runner/dist'],
    ]
    for (const [options, text] of cases) {
      const { runner } = setup(options)
      expect(runner.availability()).toMatchObject({ available: false })
      const outcome = await runner.dispatch({ repo: harbor, plan })
      expect(outcome).toMatchObject({ created: false, code: 'not_configured' })
      expect('message' in outcome ? outcome.message : '').toContain(text)
    }
    expect(repos.fixRuns.listActive()).toHaveLength(0)
  })
})

describe('LocalRunner.recover and close', () => {
  it('removes leftovers and fails local runs a restart cut short', async () => {
    await mkdir(join(dataDir, 'runner', 'old-run', 'apply'), { recursive: true })
    const { run } = repos.fixRuns.create(
      {
        repoId: harbor.id,
        plan: { fixPlanId: plan.id, scanRunId: plan.scanRunId, version: plan.version },
        runner: 'local',
        kind: 'fix',
        correlationId: 'run-cut-short',
        checksMode: 'install',
      },
      T0,
    )
    repos.fixRuns.applyEvent(run.id, { type: 'dispatch_accepted', githubRunId: null }, T0)
    const { runner } = setup()
    expect(await runner.recover()).toBe(1)
    expect(await readdir(dataDir)).toEqual([])
    expect(repos.fixRuns.getByCorrelationId('run-cut-short')).toMatchObject({
      state: 'failed',
      stateReason: 'Hinomi restarted while the local runner was working on this run.',
    })
  })

  it('kills the running children on close', async () => {
    const { runner, fake } = setup()
    await runner.close()
    expect(fake.killed()).toBe(1)
  })
})

describe('local runner helpers', () => {
  it('scrubs the token, its basic auth form, masks and token shapes', () => {
    const text = [
      `::add-mask::${BASIC}`,
      `header ${BASIC}`,
      `token ${TOKEN}`,
      'other ghs_abcdefghijklmnopqrstuvwxyz0123',
    ].join('\n')
    expect(scrubSecrets(text, [TOKEN])).toBe('header ***\ntoken ***\nother ***')
  })

  it('reads GITHUB_OUTPUT files, multi line values included', () => {
    expect(parseOutputs('a<<x1\none\nx1\nb<<x2\ntwo\nlines\nx2\n')).toEqual({
      a: 'one',
      b: 'two\nlines',
    })
  })

  it('maps the API root to the git origin', () => {
    expect(gitOrigin('https://api.github.com')).toBe('https://github.com')
    expect(gitOrigin('https://git.example.dev/api/v3')).toBe('https://git.example.dev')
  })
})
