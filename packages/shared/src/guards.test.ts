import { describe, expect, it } from 'vitest'
import { guardEvidenceSchema } from './guard-evidence.js'
import { GUARD_CHECKS, GUARD_COPY, RUNTIMES, RUNTIME_PRODUCTS } from './guards.js'

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`)

describe('GUARD_COPY', () => {
  it('has a title, explanation and fix for every level of every check', () => {
    for (const check of GUARD_CHECKS) {
      const copy = GUARD_COPY[check]
      expect(copy.title).not.toBe('')
      expect(copy.levels.length).toBeGreaterThan(0)
      for (const level of copy.levels) {
        expect(copy.explanation[level], `${check} ${level}`).toBeTruthy()
        expect(copy.fix[level], `${check} ${level}`).toBeTruthy()
      }
      expect(Object.keys(copy.explanation).sort()).toEqual([...copy.levels].sort())
    }
  })

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(GUARD_COPY)).not.toMatch(DASHES)
  })

  it('has unique docs anchors', () => {
    const anchors = GUARD_CHECKS.map((check) => GUARD_COPY[check].docsAnchor)
    expect(new Set(anchors).size).toBe(anchors.length)
  })
})

describe('runtimes', () => {
  it('covers Node, Bun and Rust with an endoflife.date product each', () => {
    expect([...RUNTIMES]).toEqual(['node', 'bun', 'rust'])
    expect(RUNTIME_PRODUCTS).toEqual({ node: 'nodejs', bun: 'bun', rust: 'rust' })
  })
})

describe('guardEvidenceSchema', () => {
  it('has one evidence shape per check', () => {
    const checks = guardEvidenceSchema.options.map((option) => option.shape.check.value).sort()
    expect(checks).toEqual([...GUARD_CHECKS].sort())
  })

  it('reads root user evidence from a Dockerfile and defaults the reason', () => {
    const evidence = guardEvidenceSchema.parse({
      check: 'root_user',
      source: 'dockerfile',
      user: null,
      path: 'apps/api/Dockerfile',
      line: 31,
      from: 'node:22-alpine',
      stage: null,
      commit: 'a'.repeat(40),
      services: [],
    })
    expect(evidence).toMatchObject({ check: 'root_user', line: 31, reason: null })
  })

  it('reads runtime support evidence for several runtimes in one repo', () => {
    const support = (product: string, line: string, eolFrom: string | null) => ({
      product,
      line,
      eolFrom,
      isEol: false,
      isEoas: null,
      latest: null,
      basis: product === 'nodejs' ? 'security' : 'release_cycle',
      daysLeft: null,
    })
    const result = guardEvidenceSchema.safeParse({
      check: 'runtime_support',
      ref: 'main',
      runtimes: [
        {
          runtime: 'node',
          result: 'warn',
          pin: {
            runtime: 'node',
            source: 'nvmrc',
            path: '.nvmrc',
            line: 1,
            raw: '22',
            lineName: '22',
            floating: false,
          },
          support: support('nodejs', '22', '2027-04-30'),
          resolvedTo: null,
          target: { line: '24', latest: null },
          fixHints: [{ path: '.nvmrc', line: 1, from: '22', to: '24' }],
        },
        {
          runtime: 'rust',
          result: 'pass',
          pin: {
            runtime: 'rust',
            source: 'rust_toolchain',
            path: 'rust-toolchain.toml',
            line: 2,
            raw: 'stable',
            lineName: null,
            floating: true,
          },
          support: null,
          resolvedTo: '1.91',
          target: null,
          fixHints: [],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects evidence of one check under another check id', () => {
    const result = guardEvidenceSchema.safeParse({
      check: 'docker_socket',
      patterns: ['apps/api/**'],
      autoDeploy: true,
      checked: [],
      skipped: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a support date that is not a day', () => {
    const result = guardEvidenceSchema.safeParse({
      check: 'action_runtime',
      actions: [
        {
          action: 'kestrel-co/setup@v1',
          using: 'node20',
          result: 'fail',
          support: {
            product: 'nodejs',
            line: '20',
            eolFrom: 'April 2026',
            isEol: true,
            isEoas: true,
            latest: null,
            basis: 'security',
            daysLeft: -190,
          },
          workflowPath: '.github/workflows/ci.yml',
          workflowLine: 12,
        },
      ],
    })
    expect(result.success).toBe(false)
  })
})
