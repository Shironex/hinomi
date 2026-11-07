import { guardEvidenceSchema, type RootUserEvidence } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { baseFacts, contextOf, deployment, SHA } from './container-fixtures.js'
import { rootUserGuard } from './root-user.js'
import { fakeRepoFiles } from './testing.js'
import type { GuardContext } from './types.js'

const NODE_USER = ['FROM node:22-alpine AS build', 'RUN npm ci', 'FROM node:22-alpine', 'USER node']

async function check(d: ReturnType<typeof deployment>, ctx: GuardContext = contextOf([d])) {
  const [result] = await rootUserGuard.run(ctx)
  const evidence = result && result.level !== null ? (result.evidence ?? null) : null
  // Evidence, when there is any, must satisfy the stored schema.
  expect(evidence === null || guardEvidenceSchema.safeParse(evidence).success).toBe(true)
  return { level: result?.level ?? null, evidence: evidence as RootUserEvidence | null }
}

describe('root_user', () => {
  describe('run options', () => {
    it('fails for --user 0 even when the Dockerfile has USER node', async () => {
      const d = deployment(
        baseFacts({
          user: '0',
          dockerfile: {
            location: null,
            baseDirectory: null,
            target: null,
            inline: {
              kind: 'non_root',
              user: 'node',
              line: 4,
              stage: null,
              from: 'node:22-alpine',
              baseImage: 'node:22-alpine',
              baseNonroot: false,
            },
          },
        }),
      )
      const { level, evidence } = await check(d)
      expect(level).toBe('fail')
      expect(evidence).toMatchObject({ source: 'run_options', user: '0' })
    })

    it('passes for a non root --user and wins over a root compose user', async () => {
      const d = deployment(
        baseFacts({
          user: '1000:1000',
          buildPack: 'dockercompose',
          services: [
            {
              name: 'web',
              user: '0',
              image: 'nginx:1.27',
              build: null,
              privileged: false,
              networkMode: null,
            },
          ],
        }),
      )
      expect((await check(d)).level).toBe('pass')
    })

    it('is unknown for an unresolved variable', async () => {
      const { level, evidence } = await check(deployment(baseFacts({ user: '${RUN_AS}' })))
      expect(level).toBe('unknown')
      expect(evidence?.reason).toContain('variable')
    })
  })

  describe('compose', () => {
    const service = (name: string, user: string | null, image: string | null) => ({
      name,
      user,
      image,
      build: null,
      privileged: false,
      networkMode: null,
    })
    const compose = (...services: ReturnType<typeof service>[]) =>
      deployment(baseFacts({ buildPack: 'dockercompose', services }))

    it('passes a service with user 1000 and fails user 0', async () => {
      expect((await check(compose(service('worker', '1000', 'kestrel/worker:2')))).level).toBe(
        'pass',
      )
      const { level, evidence } = await check(compose(service('worker', '0', 'kestrel/worker:2')))
      expect(level).toBe('fail')
      expect(evidence?.services).toEqual([
        { name: 'worker', user: '0', image: 'kestrel/worker:2', result: 'fail' },
      ])
    })

    it('warns for a service without user: on a plain image and reports the worst service', async () => {
      const { level, evidence } = await check(
        compose(service('worker', '1000', null), service('web', null, 'nginx:1.27')),
      )
      expect(level).toBe('warn')
      expect(evidence?.source).toBe('compose')
      expect(evidence?.services.map((s) => [s.name, s.result])).toEqual([
        ['worker', 'pass'],
        ['web', 'warn'],
      ])
    })

    it('passes a nonroot image tag and is unknown for a service that builds', async () => {
      expect(
        (await check(compose(service('web', null, 'gcr.io/distroless/static:nonroot')))).level,
      ).toBe('pass')
      const built = deployment(
        baseFacts({
          buildPack: 'dockercompose',
          services: [
            {
              name: 'web',
              user: null,
              image: null,
              build: { context: '.', dockerfile: null, target: null },
              privileged: false,
              networkMode: null,
            },
          ],
        }),
      )
      expect((await check(built)).level).toBe('unknown')
    })
  })

  describe('inline Dockerfile', () => {
    const reading = (over: object) => ({
      location: null,
      baseDirectory: null,
      target: null,
      inline: {
        kind: 'non_root' as const,
        user: 'node',
        line: 4,
        stage: null,
        from: 'node:22-alpine',
        baseImage: 'node:22-alpine',
        baseNonroot: false,
        ...over,
      },
    })

    it('passes with USER in the final stage, with the line and stage as evidence', async () => {
      const { level, evidence } = await check(deployment(baseFacts({ dockerfile: reading({}) })))
      expect(level).toBe('pass')
      expect(evidence).toMatchObject({
        source: 'dockerfile',
        user: 'node',
        line: 4,
        from: 'node:22-alpine',
      })
    })

    it('warns "probably root" with no USER, passes when the base tag is nonroot', async () => {
      const none = { kind: 'none' as const, user: null, line: 3 }
      const warn = await check(deployment(baseFacts({ dockerfile: reading(none) })))
      expect(warn.level).toBe('warn')
      expect(warn.evidence?.reason).toContain('probably')
      const pass = await check(
        deployment(baseFacts({ dockerfile: reading({ ...none, baseNonroot: true }) })),
      )
      expect(pass.level).toBe('pass')
    })

    it('fails for USER root and is unknown for an unresolved ARG user', async () => {
      expect(
        (
          await check(
            deployment(baseFacts({ dockerfile: reading({ kind: 'root', user: 'root' }) })),
          )
        ).level,
      ).toBe('fail')
      const { level, evidence } = await check(
        deployment(baseFacts({ dockerfile: reading({ kind: 'unknown', user: '${APP_USER}' }) })),
      )
      expect(level).toBe('unknown')
      expect(evidence?.reason).toContain('APP_USER')
    })
  })

  describe('Dockerfile fetched from the repo', () => {
    const file = { location: '/Dockerfile', baseDirectory: '/apps/api', target: null, inline: null }
    const path = 'apps/api/Dockerfile'

    it('reads it at the deployed commit sha, last USER of the final stage wins', async () => {
      const { reader, reads } = fakeRepoFiles({ [`${path}@${SHA}`]: NODE_USER.join('\n') })
      const d = deployment(baseFacts({ dockerfile: file }))
      const { level, evidence } = await check(d, contextOf([d], { repoFiles: reader }))
      expect(level).toBe('pass')
      expect(reads).toEqual([{ owner: 'kestrel-co', name: 'harbor', path, ref: SHA }])
      expect(evidence).toMatchObject({ path, commit: SHA, user: 'node', stage: null })
    })

    it('warns when USER is only in the build stage', async () => {
      const text = [
        'FROM node:22-alpine AS build',
        'USER node',
        'FROM node:22-alpine AS final',
        'CMD ["node"]',
      ]
      const { reader } = fakeRepoFiles({ [`${path}@${SHA}`]: text.join('\n') })
      const d = deployment(baseFacts({ dockerfile: file }))
      const { level, evidence } = await check(d, contextOf([d], { repoFiles: reader }))
      expect(level).toBe('warn')
      expect(evidence?.stage).toBe('final')
    })

    it('honours a build target and handles a multi line FROM with --platform', async () => {
      const text = [
        'ARG BASE=node:22-alpine',
        'FROM --platform=$BUILDPLATFORM \\',
        '  ${BASE} AS build',
        'USER root',
        'FROM ${BASE} AS runtime',
        'USER app',
      ].join('\n')
      const { reader } = fakeRepoFiles({ [`${path}@${SHA}`]: text })
      const d = deployment(baseFacts({ dockerfile: { ...file, target: 'build' } }))
      expect((await check(d, contextOf([d], { repoFiles: reader }))).level).toBe('fail')
    })

    it('reads the branch when the deployment has no full sha', async () => {
      const { reader, reads } = fakeRepoFiles({ [`${path}@main`]: 'FROM node:22\nUSER 1000' })
      const d = deployment(baseFacts({ dockerfile: file, commit: null }))
      const { level, evidence } = await check(d, contextOf([d], { repoFiles: reader }))
      expect(level).toBe('pass')
      expect(reads[0]?.ref).toBe('main')
      expect(evidence?.commit).toBeNull()
    })

    it('is unknown with a reason when the file is missing, no source reads the repo, or no ref is known', async () => {
      const d = deployment(baseFacts({ dockerfile: file }))
      const missing = await check(d, contextOf([d], { repoFiles: fakeRepoFiles({}).reader }))
      expect(missing.level).toBe('unknown')
      expect(missing.evidence?.reason).toContain('not found')
      const noSource = await check(d)
      expect(noSource.level).toBe('unknown')
      expect(noSource.evidence?.reason).toContain('no GitHub source')
      const noRef = deployment(baseFacts({ dockerfile: file, commit: null }), { gitBranch: null })
      expect((await check(noRef)).level).toBe('unknown')
    })

    it('leaves the row alone when the fetch fails', async () => {
      const d = deployment(baseFacts({ dockerfile: file }))
      const { reader } = fakeRepoFiles({}, [SHA])
      expect((await check(d, contextOf([d], { repoFiles: reader }))).level).toBeNull()
    })

    it('does not follow a location that leaves the repo', async () => {
      const { reader, reads } = fakeRepoFiles({})
      const d = deployment(baseFacts({ dockerfile: { ...file, location: '../../etc/Dockerfile' } }))
      expect((await check(d, contextOf([d], { repoFiles: reader }))).level).toBe('unknown')
      expect(reads).toEqual([])
    })
  })

  describe('gaps', () => {
    it('is unknown with the facts gap for nixpacks', async () => {
      const gap = 'this build pack does not say which user the container runs as'
      const { level, evidence } = await check(
        deployment(baseFacts({ buildPack: 'nixpacks', gaps: { user: gap } })),
      )
      expect(level).toBe('unknown')
      expect(evidence).toMatchObject({ source: 'none', reason: gap })
    })

    it('is unknown for an image only deployment, pass for a nonroot tag', async () => {
      const image = (ref: string) =>
        deployment(baseFacts({ buildPack: 'dockerimage', image: ref, gaps: { user: 'no signal' } }))
      expect((await check(image('ghcr.io/kestrel-co/harbor:1.4.0'))).level).toBe('unknown')
      expect((await check(image('gcr.io/distroless/nodejs22:nonroot'))).level).toBe('pass')
    })

    it('is unknown when the facts were never read, and skips managed databases', async () => {
      expect((await check(deployment(null))).level).toBe('unknown')
      const db = deployment(baseFacts(), { kind: 'database' })
      expect(await rootUserGuard.run(contextOf([db]))).toEqual([])
    })
  })
})
