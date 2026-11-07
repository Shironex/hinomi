import { describe, expect, it } from 'vitest'
import { runnerPlan, runnerResult } from './testing.js'
import {
  compareTargets,
  targetedFindingIds,
  watchPathRegExp,
  watchPathsTrigger,
  watchPathsWarning,
} from './verify.js'

// Pure parts of the deployment link and the verification. Repos, apps and packages are fictional.

const AT = new Date('2026-11-07T12:00:00.000Z')
const repo = {
  id: 1,
  owner: 'kestrel-co',
  name: 'harbor',
  defaultBranch: 'main',
  archived: false,
  alertsEnabled: true,
  lastScannedAt: null,
  runnerEnabled: true,
  runnerWorkflow: null,
  runnerMajorsAgent: 'off' as const,
  runnerKind: 'github_actions' as const,
  sourceId: null,
  sourceOverrideId: null,
  createdAt: AT,
  updatedAt: AT,
}

describe('watch paths', () => {
  it('matches like Coolify: ** crosses folders, * and ? do not', () => {
    expect(watchPathRegExp('apps/api/**').test('apps/api/src/index.ts')).toBe(true)
    expect(watchPathRegExp('apps/*/package.json').test('apps/api/package.json')).toBe(true)
    expect(watchPathRegExp('apps/*/package.json').test('apps/api/nested/package.json')).toBe(false)
    expect(watchPathRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
    expect(watchPathRegExp('v?.txt').test('v1.txt')).toBe(true)
    expect(watchPathRegExp('pnpm-lock.yaml').test('pnpm-lockxyaml')).toBe(false)
  })

  it('reads patterns in order and lets the last match win', () => {
    const patterns = ['apps/api/**', '!apps/api/**/*.md']
    expect(watchPathsTrigger(patterns, 'apps/api/src/a.ts')).toBe(true)
    expect(watchPathsTrigger(patterns, 'apps/api/docs/readme.md')).toBe(false)
    expect(watchPathsTrigger([...patterns, 'apps/api/docs/**'], 'apps/api/docs/readme.md')).toBe(
      true,
    )
    expect(watchPathsTrigger([], 'anything')).toBe(true)
    expect(watchPathsTrigger(['', '  '], 'anything')).toBe(true)
  })

  it('warns when no changed file would trigger a deploy', () => {
    const app = { id: 7, name: 'harbor-web', watchPaths: ['apps/web/**', 'packages/ui/**'] }
    const warning = watchPathsWarning(app, ['pnpm-lock.yaml', 'package.json'], AT)
    expect(warning).toMatchObject({ code: 'watch_paths_skip', deploymentId: 7 })
    expect(warning?.message).toContain('pnpm-lock.yaml, package.json')
    expect(warning?.message).toContain('may not happen automatically')
    expect(watchPathsWarning(app, ['apps/web/package.json'], AT)).toBeNull()
    expect(watchPathsWarning({ ...app, watchPaths: null }, ['pnpm-lock.yaml'], AT)).toBeNull()
    expect(watchPathsWarning(app, [], AT)).toBeNull()
  })
})

describe('targeted findings', () => {
  const plan = runnerPlan(repo, 10, AT)

  it('takes the safe steps the runner applied, never the risky ones', () => {
    expect(targetedFindingIds(plan, runnerResult(plan, 'corr-1'))).toEqual([1, 2])
  })

  it('keeps steps found already fixed and drops failed or other skips', () => {
    const result = runnerResult(plan, 'corr-1')
    result.steps = [
      { id: 's1', status: 'skipped', reason: 'already_fixed', detail: null, files: [] },
      { id: 's2', status: 'failed', reason: 'install_failed', detail: 'boom', files: [] },
    ]
    expect(targetedFindingIds(plan, result)).toEqual([1])
    result.steps[0] = { ...result.steps[0]!, reason: 'too_new' }
    expect(targetedFindingIds(plan, result)).toEqual([])
  })

  it('takes the major upgrades for a majors run, those whose lockfile the agent changed', () => {
    expect(targetedFindingIds(plan, null, 'majors')).toEqual([3])
    const result = runnerResult(plan, 'corr-1')
    result.steps = [{ id: 's3', status: 'applied', reason: null, detail: null, files: [] }]
    expect(targetedFindingIds(plan, result, 'majors')).toEqual([3])
    result.steps = [{ id: 's3', status: 'skipped', reason: null, detail: 'unchanged', files: [] }]
    expect(targetedFindingIds(plan, result, 'majors')).toEqual([])
  })

  it('falls back to every safe step without a result, and to null without a plan', () => {
    expect(targetedFindingIds(plan, null)).toEqual([1, 2])
    expect(targetedFindingIds(null, null)).toBeNull()
  })
})

describe('comparing after a rescan', () => {
  const states = new Map([
    [1, 'fixed' as const],
    [2, 'open' as const],
    [3, 'snoozed' as const],
  ])

  it('splits cleared, still open and new findings', () => {
    const compared = compareTargets([1, 2, 3, 4], (id) => states.get(id), [2, 9, 8, 9])
    expect(compared).toEqual({ cleared: [1, 4], stillOpen: [2, 3], new: [8, 9] })
  })

  it('clears everything when every target is fixed', () => {
    expect(compareTargets([1], (id) => states.get(id), [])).toEqual({
      cleared: [1],
      stillOpen: [],
      new: [],
    })
  })
})
