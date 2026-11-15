import { actionRuntimeEvidenceSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { RepoRow } from '../../db/schema.js'
import { actionRuntimeGuard, actionRuntimeResult } from './action-runtime.js'
import { parseActionManifest, parseUse, parseWorkflowUses } from './action-manifest.js'
import { RUNTIME_NOW, runtimeSupportIndex } from './runtime-testing.js'
import { fakeRepoFiles } from './testing.js'
import type { GuardContext, GuardSubjectResult } from './types.js'

// Fictional repo of kestrel-co, judged on 2027-02-15: Node 20 ended 2026-04-30 (fail), Node 22
// ends in 73 days (warn), Node 24 is fine.

const support = runtimeSupportIndex()
const options = { now: RUNTIME_NOW, windowDays: 90 }
const repo = { id: 7, owner: 'kestrel-co', name: 'harbor' } as RepoRow
const REF = 'main'

function workflow(...uses: string[]): string {
  return [
    'name: ci',
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...uses.map((u) => `      - uses: ${u}`),
  ].join('\n')
}

const action = (using: string) => `name: x\nruns:\n  using: ${using}\n  main: index.js\n`

const evidenceOf = (result: GuardSubjectResult | null) => {
  expect(result).not.toBeNull()
  const evidence = 'evidence' in result! ? result.evidence : undefined
  return actionRuntimeEvidenceSchema.parse(evidence)
}

describe('parsing', () => {
  it('reads remote uses with a subpath and skips local, docker and expression uses', () => {
    expect(parseUse('kestrel-co/tools/lint@v2')).toMatchObject({
      owner: 'kestrel-co',
      repo: 'tools',
      subpath: 'lint',
      ref: 'v2',
    })
    expect(parseUse('./local')).toBeNull()
    expect(parseUse('docker://alpine:3')).toBeNull()
    expect(parseUse('kestrel-co/x@${{ inputs.ref }}')).toBeNull()
  })

  it('finds the line of each uses and the nodes of an action file', () => {
    const uses = parseWorkflowUses(workflow('kestrel-co/a@v1', 'kestrel-co/b@v2'))
    expect(uses.map((u) => [u.raw, u.line])).toEqual([
      ['kestrel-co/a@v1', 7],
      ['kestrel-co/b@v2', 8],
    ])
    expect(parseActionManifest(action('node20'))).toEqual({ using: 'node20', uses: [] })
    expect(parseActionManifest('not: an action')).toBeNull()
  })
})

describe('action runtime', () => {
  it('fails an action on a Node line past end of life and says where it is used', async () => {
    const t = fakeRepoFiles({
      [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/old@v1', 'kestrel-co/new@v3'),
      'action.yml@v1': action('node20'),
      'action.yml@v3': action('node24'),
    })
    const result = await actionRuntimeResult(repo, REF, t.reader, support, options)
    expect(result).toMatchObject({ subject: { repoId: 7 }, level: 'fail' })
    const evidence = evidenceOf(result)
    expect(evidence.actions).toHaveLength(2)
    expect(evidence.actions[0]).toMatchObject({
      action: 'kestrel-co/old@v1',
      using: 'node20',
      result: 'fail',
      workflowPath: '.github/workflows/ci.yml',
      workflowLine: 7,
      support: { line: '20', isEol: true },
    })
    expect(evidence.actions[1]).toMatchObject({ using: 'node24', result: 'pass' })
  })

  it('warns inside the window and passes when every action is on a supported line', async () => {
    const wf = `.github/workflows/ci.yml@${REF}`
    const warn = fakeRepoFiles({
      [wf]: workflow('kestrel-co/a@v1'),
      'action.yml@v1': action('node22'),
    })
    expect(await actionRuntimeResult(repo, REF, warn.reader, support, options)).toMatchObject({
      level: 'warn',
    })
    const pass = fakeRepoFiles({
      [wf]: workflow('kestrel-co/a@v1'),
      'action.yml@v1': action('node24'),
    })
    expect(await actionRuntimeResult(repo, REF, pass.reader, support, options)).toMatchObject({
      level: 'pass',
    })
  })

  it('judges the repo own action.yml', async () => {
    const t = fakeRepoFiles({ [`action.yml@${REF}`]: action('node20') })
    const result = await actionRuntimeResult(repo, REF, t.reader, support, options)
    // No workflow folder: listing is missing, the own action still counts.
    expect(result).toMatchObject({ level: 'fail' })
    expect(evidenceOf(result).actions[0]).toMatchObject({ action: 'self', workflowPath: null })
  })

  it('gives nothing for docker and composite actions, and follows a composite one level', async () => {
    const composite = [
      'runs:',
      '  using: composite',
      '  steps:',
      '    - uses: kestrel-co/inner@v1',
      '    - run: echo hi',
    ].join('\n')
    const t = fakeRepoFiles({
      [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/wrap@v1', 'kestrel-co/box@v1'),
      'action.yml@v1': action('docker'),
    })
    expect(await actionRuntimeResult(repo, REF, t.reader, support, options)).toMatchObject({
      level: 'pass',
    })

    const nested = fakeRepoFiles({
      [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/wrap@v2'),
      'action.yml@v2': composite,
      // The inner action is read at its own ref; both share the file name, so key by ref.
      'action.yml@v1': action('node20'),
    })
    const result = await actionRuntimeResult(repo, REF, nested.reader, support, options)
    expect(result).toMatchObject({ level: 'fail' })
    const entry = evidenceOf(result).actions[0]
    expect(entry).toMatchObject({
      action: 'kestrel-co/inner@v1 (via kestrel-co/wrap@v2)',
      workflowLine: 7,
    })
  })

  it('does not follow a composite inside a composite', async () => {
    const hop = (next: string) => `runs:\n  using: composite\n  steps:\n    - uses: ${next}\n`
    const t = fakeRepoFiles({
      [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/one@v1'),
      'action.yml@v1': hop('kestrel-co/two@v2'),
      'action.yml@v2': hop('kestrel-co/three@v3'),
      'action.yml@v3': action('node20'),
    })
    const result = await actionRuntimeResult(repo, REF, t.reader, support, options)
    expect(result).toMatchObject({ level: 'pass' })
    expect(evidenceOf(result).actions).toEqual([])
  })

  it('is unknown for a Node line the support data lacks', async () => {
    const t = fakeRepoFiles({
      [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/a@v9'),
      'action.yml@v9': action('node40'),
    })
    expect(await actionRuntimeResult(repo, REF, t.reader, support, options)).toMatchObject({
      level: 'unknown',
    })
  })

  it('leaves the row alone when a read fails and nothing worse was found', async () => {
    const t = fakeRepoFiles({ [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/a@v1') }, [
      'v1',
    ])
    expect(await actionRuntimeResult(repo, REF, t.reader, support, options)).toBeNull()
  })
})

describe('guard', () => {
  const ctx = (over: Partial<GuardContext>): GuardContext =>
    ({
      repos: [repo],
      scans: new Map([[7, { pins: { ref: REF, pins: [], error: null } }]]),
      support,
      supportWindowDays: 90,
      now: RUNTIME_NOW,
      ...over,
    }) as unknown as GuardContext

  it('leaves everything alone without support data or pins', async () => {
    const t = fakeRepoFiles({})
    expect(await actionRuntimeGuard.run(ctx({ support: null, repoFiles: t.reader }))).toEqual([])
    expect(await actionRuntimeGuard.run(ctx({ scans: new Map(), repoFiles: t.reader }))).toEqual([])
  })

  it('reads the workflows at the ref the pins were read at', async () => {
    const t = fakeRepoFiles({
      [`.github/workflows/ci.yml@${REF}`]: workflow('kestrel-co/a@v1'),
      'action.yml@v1': action('node20'),
    })
    const results = await actionRuntimeGuard.run(ctx({ repoFiles: t.reader }))
    expect(results).toMatchObject([{ subject: { repoId: 7 }, level: 'fail' }])
  })
})
