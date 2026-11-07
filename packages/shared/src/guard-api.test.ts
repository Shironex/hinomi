import { describe, expect, it } from 'vitest'
import {
  checkOverridesQuerySchema,
  createCheckOverrideRequestSchema,
  findingsQuerySchema,
  updateCheckOverrideRequestSchema,
} from './api.js'
import { OVERRIDABLE_CHECKS } from './guards.js'

describe('check override requests', () => {
  it('accepts a guard check or a blind spot type for one deployment', () => {
    expect(OVERRIDABLE_CHECKS).toContain('archived_deployed')
    const body = { check: 'docker_socket', deploymentId: 4, reason: 'socket proxy on purpose' }
    expect(createCheckOverrideRequestSchema.parse(body)).toEqual(body)
    expect(
      createCheckOverrideRequestSchema.safeParse({
        check: 'archived_deployed',
        repoId: 2,
        reason: 'frozen internal tool',
      }).success,
    ).toBe(true)
  })

  it('needs exactly one of deploymentId and repoId', () => {
    const both = { check: 'root_user', deploymentId: 1, repoId: 2, reason: 'x' }
    const neither = { check: 'root_user', reason: 'x' }
    expect(createCheckOverrideRequestSchema.safeParse(both).success).toBe(false)
    expect(createCheckOverrideRequestSchema.safeParse(neither).success).toBe(false)
  })

  it('needs a reason and rejects unknown checks', () => {
    expect(
      createCheckOverrideRequestSchema.safeParse({
        check: 'root_user',
        deploymentId: 1,
        reason: ' ',
      }).success,
    ).toBe(false)
    expect(
      createCheckOverrideRequestSchema.safeParse({
        check: 'privileged',
        deploymentId: 1,
        reason: 'x',
      }).success,
    ).toBe(false)
    expect(updateCheckOverrideRequestSchema.safeParse({ reason: '' }).success).toBe(false)
  })

  it('filters overrides by check, deployment and repo', () => {
    expect(
      checkOverridesQuerySchema.parse({ check: 'root_user,archived_deployed', deployment: '3' }),
    ).toEqual({ check: ['root_user', 'archived_deployed'], deployment: [3] })
  })
})

describe('guard filters on findings', () => {
  it('parses check, level and release', () => {
    const query = findingsQuerySchema.parse({
      kind: 'guard',
      check: 'root_user,docker_socket',
      level: 'fail,warn',
      release: 'false',
    })
    expect(query).toMatchObject({
      kind: ['guard'],
      check: ['root_user', 'docker_socket'],
      level: ['fail', 'warn'],
      release: false,
    })
  })

  it('rejects unknown levels', () => {
    expect(findingsQuerySchema.safeParse({ level: 'pass' }).success).toBe(false)
  })
})
