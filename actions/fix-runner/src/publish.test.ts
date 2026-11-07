import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIX_RESULT_SCHEMA, parseFixResult, type FixResultV1 } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { FixRunnerError } from './errors.js'
import { main } from './main.js'
import type { Command, Exec } from './exec.js'
import { commitMessage, parsePatchPaths, publishPatch, verifyPublish } from './publish.js'
import { nodeRepoFs } from './repo-fs.js'
import { REPO, fakeExec, fixtureRepo, git, silentLogger } from './testing.js'

const BUMP_PATCH = [
  'diff --git a/package.json b/package.json',
  'index 1111111..2222222 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1 +1 @@',
  '--- a removed line that looks like a header',
  '+++ an added line that looks like one too',
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  'index 3333333..4444444 100644',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n')

describe('parsePatchPaths', () => {
  it('lists the files and ignores header lookalikes inside hunks', () => {
    expect(parsePatchPaths(BUMP_PATCH)).toEqual(['package.json', 'pnpm-lock.yaml'])
  })

  it.each([
    ['a rename', 'diff --git a/package.json b/package.json\nrename from x\n'],
    ['two names', 'diff --git a/package.json b/src/index.ts\n'],
    ['a quoted path', 'diff --git "a/pack age.json" "b/pack age.json"\n'],
    ['a symlink', 'diff --git a/package.json b/package.json\nnew file mode 120000\n'],
    [
      'a mode change',
      'diff --git a/package.json b/package.json\nold mode 100644\nnew mode 100755\n',
    ],
    ['a symlink index', 'diff --git a/package.json b/package.json\nindex 1..2 120000\n'],
    ['a deletion', 'diff --git a/package.json b/package.json\ndeleted file mode 100644\n'],
    ['another target', 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/x\n'],
    ['text first', 'hello\ndiff --git a/package.json b/package.json\n'],
    ['nothing', ''],
    [
      'binary without data',
      'diff --git a/bun.lockb b/bun.lockb\nBinary files a/bun.lockb and b/bun.lockb differ\n',
    ],
  ])('refuses %s', (_name, text) => {
    expect(() => parsePatchPaths(text)).toThrow(FixRunnerError)
  })
})

const BASE = 'a'.repeat(40)

function result(patch: string | null, overrides: Partial<FixResultV1> = {}): FixResultV1 {
  return parseFixResult({
    schema: FIX_RESULT_SCHEMA,
    runId: 'run-7',
    planScanRunId: 41,
    repo: REPO,
    baseSha: BASE,
    packageManager: 'pnpm',
    packageManagerVersion: '10.34.9',
    checksMode: 'install',
    steps: [
      {
        id: 'step-1',
        status: 'applied',
        reason: null,
        detail: null,
        files: ['package.json'],
      },
    ],
    releaseAge: [],
    install: { status: 'ok', durationMs: 10, output: null, truncated: false },
    checks: [],
    patch:
      patch === null
        ? null
        : {
            sha256: createHash('sha256').update(patch).digest('hex'),
            files: parsePatchPaths(patch),
            insertions: 1,
            deletions: 1,
          },
    finishedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  })
}

function check(patch: string, overrides: Partial<Parameters<typeof verifyPublish>[0]> = {}) {
  return verifyPublish({
    patch: Buffer.from(patch, 'utf8'),
    result: overrides.result ?? result(patch),
    expectedSha256: createHash('sha256').update(patch).digest('hex'),
    expectedFiles: ['package.json', 'pnpm-lock.yaml'],
    baseSha: BASE,
    repository: REPO,
    runId: 'run-7',
    ...overrides,
  })
}

describe('verifyPublish', () => {
  it('accepts a patch that matches the apply job outputs', () => {
    expect(check(BUMP_PATCH)).toEqual(['package.json', 'pnpm-lock.yaml'])
  })

  it('refuses a patch whose hash differs from the apply job output', () => {
    expect(() => check(BUMP_PATCH, { expectedSha256: 'b'.repeat(64) })).toThrow(
      'SHA-256 differs from the apply job output',
    )
  })

  it('refuses a patch swapped together with its result file', () => {
    const other = BUMP_PATCH.replace('+b', '+c')
    expect(() =>
      verifyPublish({
        patch: Buffer.from(other),
        result: result(other),
        expectedSha256: createHash('sha256').update(BUMP_PATCH).digest('hex'),
        expectedFiles: ['package.json', 'pnpm-lock.yaml'],
        baseSha: BASE,
        repository: REPO,
        runId: 'run-7',
      }),
    ).toThrow('SHA-256 differs from the apply job output')
  })

  it('refuses files the apply job did not list', () => {
    expect(() => check(BUMP_PATCH, { expectedFiles: ['package.json'] })).toThrow(
      'the apply job listed package.json',
    )
  })

  it('refuses a file outside the dependency allowlist even when listed', () => {
    const patch = BUMP_PATCH.replaceAll('pnpm-lock.yaml', 'scripts/postinstall.js')
    expect(() =>
      check(patch, { expectedFiles: ['package.json', 'scripts/postinstall.js'] }),
    ).toThrow('scripts/postinstall.js is not a dependency file')
  })

  it('refuses a workflow file', () => {
    // The result schema already refuses such a path, so the result here lists the safe files.
    const patch = BUMP_PATCH.replaceAll('pnpm-lock.yaml', '.github/workflows/ci.yml')
    const sha256 = createHash('sha256').update(patch).digest('hex')
    const base = result(BUMP_PATCH)
    expect(() =>
      check(patch, {
        result: { ...base, patch: base.patch && { ...base.patch, sha256 } },
        expectedFiles: ['package.json', '.github/workflows/ci.yml'],
      }),
    ).toThrow('.github/workflows/ci.yml is not a dependency file')
  })

  it('refuses another repo, run or base commit', () => {
    expect(() => check(BUMP_PATCH, { repository: 'kestrel-co/other' })).toThrow('this run is in')
    expect(() => check(BUMP_PATCH, { runId: 'run-8' })).toThrow('not run-8')
    expect(() => check(BUMP_PATCH, { baseSha: 'c'.repeat(40) })).toThrow('another base commit')
    expect(() => check(BUMP_PATCH, { baseSha: '' })).toThrow('no base commit')
    expect(() => check(BUMP_PATCH, { expectedSha256: '' })).toThrow('no patch hash')
  })
})

/** A fixture repo with a real patch of package.json and the lockfile against its HEAD. */
async function repoWithPatch() {
  const root = await fixtureRepo('pnpm-package-overrides')
  const fs = nodeRepoFs(root)
  const pkg = (await fs.read('package.json')) ?? ''
  await fs.write('package.json', pkg.replace('"private": true', '"private": true,\n  "x": 1'))
  await fs.write('pnpm-lock.yaml', `${(await fs.read('pnpm-lock.yaml')) ?? ''}# changed\n`)
  const patch = git(root, 'diff', '--binary', '--no-color', 'HEAD')
  git(root, 'checkout', '--', '.')
  const dir = mkdtempSync(join(tmpdir(), 'hinomi-publish-'))
  const patchPath = join(dir, 'fix.patch')
  writeFileSync(patchPath, patch, 'utf8')
  const baseSha = git(root, 'rev-parse', 'HEAD').trim()
  return { root, patch, patchPath, baseSha }
}

/** Real git for everything but push, which is only recorded. */
function recordingExec(): Exec & { pushes: Command[] } {
  const real = fakeExec(() => ({}))
  const pushes: Command[] = []
  return {
    pushes,
    run(command, options) {
      if (command.args.includes('push')) {
        pushes.push(command)
        return Promise.resolve({ code: 0, output: '', timedOut: false, durationMs: 1 })
      }
      return real.run(command, options)
    },
  }
}

describe('publishPatch', () => {
  it('applies the patch on the base commit and commits it as github-actions[bot] in a dry run', async () => {
    const { root, patch, patchPath, baseSha } = await repoWithPatch()
    const exec = recordingExec()
    const fixResult = result(patch, { baseSha })
    const paths = parsePatchPaths(patch)
    const outcome = await publishPatch({
      exec,
      log: silentLogger(),
      root,
      patchPath,
      paths,
      result: fixResult,
      baseSha,
      dryRun: true,
      token: '',
      serverUrl: 'https://github.com',
      repository: REPO,
      write: () => {},
    })
    expect(outcome).toMatchObject({ branch: 'hinomi/fix-plan', pushed: false })
    expect(exec.pushes).toEqual([])
    expect(git(root, 'log', '-1', '--format=%an <%ae>%n%s')).toBe(
      'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>\nfix(deps): apply hinomi fix plan 41\n',
    )
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(paths)
  })

  it('pushes the fix branch with the token in the environment, never in argv', async () => {
    const { root, patch, patchPath, baseSha } = await repoWithPatch()
    const exec = recordingExec()
    const lines: string[] = []
    const outcome = await publishPatch({
      exec,
      log: silentLogger(),
      root,
      patchPath,
      paths: parsePatchPaths(patch),
      result: result(patch, { baseSha }),
      baseSha,
      dryRun: false,
      token: 'ghs_exampletoken',
      serverUrl: 'https://github.com',
      repository: REPO,
      write: (line) => lines.push(line),
    })
    expect(outcome.pushed).toBe(true)
    const push = exec.pushes[0]
    expect(push?.args.slice(-4)).toEqual([
      '--force',
      '--no-verify',
      `https://github.com/${REPO}.git`,
      'HEAD:refs/heads/hinomi/fix-plan',
    ])
    expect(push?.args.join(' ')).not.toContain('ghs_exampletoken')
    const basic = Buffer.from('x-access-token:ghs_exampletoken').toString('base64')
    expect(push?.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${basic}`)
    expect(lines).toContain(`::add-mask::${basic}`)
  })

  it('refuses a checkout at another commit', async () => {
    const { root, patch, patchPath } = await repoWithPatch()
    await expect(
      publishPatch({
        exec: recordingExec(),
        log: silentLogger(),
        root,
        patchPath,
        paths: parsePatchPaths(patch),
        result: result(patch),
        baseSha: BASE,
        dryRun: true,
        token: '',
        serverUrl: 'https://github.com',
        repository: REPO,
        write: () => {},
      }),
    ).rejects.toThrow('the patch is for')
  })

  it('writes a conventional commit message', () => {
    expect(commitMessage(result(null))).toBe(
      'fix(deps): apply hinomi fix plan 41\n\nHinomi fix run run-7: 1 of 1 steps applied.\n',
    )
  })
})

describe('main publish step', () => {
  it('verifies against the inputs and commits without pushing in a dry run', async () => {
    const { root, patch, patchPath, baseSha } = await repoWithPatch()
    const dir = join(patchPath, '..')
    writeFileSync(join(dir, 'hinomi-result.json'), JSON.stringify(result(patch, { baseSha })))
    const out = join(dir, 'out')
    const run = (sha256: string) =>
      main({
        env: {
          GITHUB_WORKSPACE: root,
          GITHUB_REPOSITORY: REPO,
          GITHUB_OUTPUT: out,
          PATH: process.env.PATH,
          INPUT_STEP: 'publish',
          INPUT_RUN_ID: 'run-7',
          INPUT_ARTIFACT_DIR: dir,
          INPUT_BASE_SHA: baseSha,
          INPUT_PATCH_SHA256: sha256,
          INPUT_PATCH_FILES: JSON.stringify(parsePatchPaths(patch)),
          INPUT_DRY_RUN: 'true',
        },
        write: () => {},
        fetch: () => Promise.reject(new Error('no network in tests')),
      })
    expect(await run('f'.repeat(64))).toBe(1)
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(baseSha)
    expect(await run(createHash('sha256').update(patch).digest('hex'))).toBe(0)
    expect(readFileSync(out, 'utf8')).toMatch(/^pushed<<\S+\nfalse\n/m)
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('fix(deps): apply hinomi fix plan 41')
  })
})
