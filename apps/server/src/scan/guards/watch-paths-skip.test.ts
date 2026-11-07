import { describe, expect, it } from 'vitest'
import { context, deployment, facts, reasonOf, repo, resultFor } from './network-fixtures.js'
import { evaluateWatchPathsSkip } from './watch-paths-skip.js'

const harbor = repo(1, 'harbor')

/** An app of kestrel-co/harbor with a Dockerfile in apps/api. */
function api(
  over: Parameters<typeof deployment>[2] = {},
  factsOver: Parameters<typeof facts>[0] = {},
) {
  return deployment(1, 'harbor-api', {
    repoId: 1,
    watchPaths: ['apps/api/src/**'],
    facts: facts({
      dockerfile: {
        location: '/Dockerfile',
        baseDirectory: '/apps/api',
        target: null,
        inline: null,
      },
      ...factsOver,
    }),
    ...over,
  })
}

const run = (row = api(), lockfiles: Record<number, string[] | null> = { 1: ['pnpm-lock.yaml'] }) =>
  resultFor(evaluateWatchPathsSkip(context([row], [harbor], lockfiles)), row.id)

describe('watch_paths_skip', () => {
  it('warns and lists the Dockerfile, lockfile and manifest the paths skip', () => {
    const result = run()
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({
      patterns: ['apps/api/src/**'],
      autoDeploy: true,
      skipped: ['apps/api/Dockerfile', 'pnpm-lock.yaml', 'package.json'],
    })
  })

  it('passes when the paths cover the Dockerfile, the lockfile and the manifest', () => {
    const row = api({ watchPaths: ['apps/api/**', 'pnpm-lock.yaml', 'package.json'] })
    const result = run(row)
    expect(result.level).toBe('pass')
    expect(result.level !== null && result.evidence).toMatchObject({ skipped: [] })
  })

  it('warns on a lockfile that a negated pattern skips', () => {
    const row = deployment(1, 'harbor-core', {
      repoId: 1,
      watchPaths: ['**', '!**/*.lock'],
      facts: facts({ dockerfile: null }),
    })
    const result = run(row, { 1: ['Cargo.lock'] })
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({ skipped: ['Cargo.lock'] })
  })

  it('passes with no watch paths', () => {
    expect(run(api({ watchPaths: [] })).level).toBe('pass')
    expect(run(api({ watchPaths: null })).level).toBe('pass')
  })

  it('passes with auto deploy off and says so', () => {
    const result = run(api({}, { autoDeploy: false }))
    expect(result.level).toBe('pass')
    expect(result.level !== null && result.evidence).toMatchObject({ autoDeploy: false })
    expect(reasonOf(result)).toContain('off')
  })

  it('leaves out the lockfiles of other apps in the monorepo', () => {
    const result = run(api({ watchPaths: ['apps/api/**', 'pnpm-lock.yaml', 'package.json'] }), {
      1: ['pnpm-lock.yaml', 'apps/web/pnpm-lock.yaml'],
    })
    expect(result.level).toBe('pass')
  })

  it('checks only root lockfiles when the base folder is not known', () => {
    const row = deployment(1, 'harbor-web', {
      repoId: 1,
      watchPaths: ['apps/web/**'],
      facts: facts({ dockerfile: null }),
    })
    const result = run(row, { 1: ['apps/api/pnpm-lock.yaml', 'pnpm-lock.yaml'] })
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({
      checked: ['pnpm-lock.yaml', 'package.json'],
    })
  })

  it('checks the Dockerfile alone and notes it when the lockfiles were not read', () => {
    const result = run(api(), { 1: null })
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({
      skipped: ['apps/api/Dockerfile'],
    })
    expect(reasonOf(result)).toContain('lockfiles')
  })

  it('is unknown when the facts have gaps', () => {
    expect(run(api({ facts: null })).level).toBe('unknown')
    expect(
      run(api({}, { gaps: { watchPaths: 'the source does not report watch paths' } })).level,
    ).toBe('unknown')
    const auto = run(
      api({}, { autoDeploy: null, gaps: { autoDeploy: 'Coolify did not report auto deploy' } }),
    )
    expect(auto.level).toBe('unknown')
  })

  it('leaves services and databases out', () => {
    const service = deployment(2, 'harbor-cache', { kind: 'service' })
    const database = deployment(3, 'harbor-db', { kind: 'database' })
    expect(evaluateWatchPathsSkip(context([service, database]))).toEqual([])
  })

  it('does not trust lockfile names from the repo', () => {
    const row = api({ watchPaths: ['apps/api/**'] })
    const results = evaluateWatchPathsSkip(
      context([row], [harbor], { 1: ['__proto__', 'constructor', 'prototype', 'pnpm-lock.yaml'] }),
    )
    const result = resultFor(results, 1)
    expect(result.level).toBe('warn')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(result.level !== null && result.evidence).toMatchObject({
      skipped: ['__proto__', 'constructor', 'prototype', 'pnpm-lock.yaml', 'package.json'],
    })
  })
})
