import { runtimePinsDisagreeEvidenceSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { RepoRow } from '../../db/schema.js'
import type { RepoScan } from '../collect.js'
import { evaluateRuntimePins, runtimePinsDisagreeGuard } from './runtime-pins-disagree.js'
import { RUNTIME_NOW, pinsOf, setupNodeWorkflow } from './runtime-testing.js'
import { noRepoFiles } from './testing.js'
import type { GuardContext, GuardSubjectResult } from './types.js'

const evidenceOf = (result: GuardSubjectResult) =>
  'evidence' in result ? result.evidence : undefined

// Fictional repos of kestrel-co. Every Dockerfile here is deployed unless a test says otherwise.

function node(files: Record<string, string>, deployed: string[] = ['Dockerfile']) {
  return evaluateRuntimePins(pinsOf(files, deployed), 'node')
}

describe('runtime_pins_disagree', () => {
  it('warns when the deployed Dockerfile runs 26 and CI tests on 22 only', () => {
    const result = node({
      Dockerfile: 'FROM node:26-alpine\n',
      '.github/workflows/ci.yml': setupNodeWorkflow({ test: '22' }),
    })!
    expect(result.entry).toMatchObject({
      runtime: 'node',
      result: 'warn',
      productionLine: '26',
      reason: 'Node pins disagree: production runs 26, CI tests on 22 only.',
    })
    expect(result.entry.disagreeing.map((p) => p.source)).toEqual(['setup_node'])
    expect(result.entry.fixHints).toEqual([
      expect.objectContaining({ path: '.github/workflows/ci.yml', from: '22', to: '26' }),
    ])
  })

  it('does not count a matrix of 22 and 24 as a disagreement with itself', () => {
    const ci = { '.github/workflows/ci.yml': setupNodeWorkflow({ test: ['22', '24'] }) }
    expect(node(ci)!.entry.result).toBe('pass')
    expect(node({ ...ci, Dockerfile: 'FROM node:24\n' })!.entry.result).toBe('pass')
    const off = node({ ...ci, Dockerfile: 'FROM node:26\n' })!
    expect(off.entry.result).toBe('warn')
    expect(off.entry.reason).toContain('CI tests on 22, 24 only')
  })

  it('accepts other CI jobs on other lines while one uses the production line', () => {
    const result = node({
      Dockerfile: 'FROM node:24\n',
      '.github/workflows/ci.yml': setupNodeWorkflow({ lint: '22', test: '24' }),
    })!
    expect(result.entry.result).toBe('pass')
  })

  it('warns when a version file names another line than production', () => {
    const result = node({ Dockerfile: 'FROM node:22\n', '.nvmrc': '24\n' })!
    expect(result.entry).toMatchObject({ result: 'warn', productionLine: '22' })
    expect(result.entry.reason).toBe('Node pins disagree: production runs 22, .nvmrc says 24.')
    expect(result.entry.fixHints).toEqual([
      expect.objectContaining({ path: '.nvmrc', from: '24', to: '22' }),
    ])
  })

  it('checks an engines range only for lines that do not fit it', () => {
    const manifest = (range: string) =>
      JSON.stringify({ name: 'kestrel-web', engines: { node: range } })
    expect(node({ '.nvmrc': '24\n', 'package.json': manifest('>=20') })!.entry.result).toBe('pass')
    const narrow = node({ '.nvmrc': '24\n', 'package.json': manifest('>=20 <23') })!
    expect(narrow.entry.result).toBe('warn')
    expect(narrow.entry.reason).toContain('package.json >=20 <23 excludes 24')
    expect(narrow.entry.fixHints).toEqual([
      expect.objectContaining({ path: 'package.json', from: '>=20 <23', to: '>=24' }),
    ])
  })

  it('lets a pure build stage differ, but not one whose node_modules the image copies', () => {
    const pure =
      'FROM node:20 AS assets\nRUN npm run build\nFROM node:22\nCOPY --from=assets /app/dist ./dist\n'
    expect(node({ Dockerfile: pure })!.entry.result).toBe('pass')
    const copies =
      'FROM node:20 AS deps\nRUN npm ci\nFROM node:22\nCOPY --from=deps /app/node_modules ./node_modules\n'
    const result = node({ Dockerfile: copies })!
    expect(result.entry.result).toBe('warn')
    expect(result.entry.disagreeing).toEqual([
      expect.objectContaining({ path: 'Dockerfile', line: 1, raw: 'node:20' }),
    ])
  })

  it('counts a Dockerfile no deployment builds like a version file', () => {
    const result = node(
      { 'apps/api/Dockerfile': 'FROM node:24\n', 'tools/Dockerfile.dev': 'FROM node:20\n' },
      ['apps/api/Dockerfile'],
    )!
    expect(result.entry.result).toBe('warn')
    expect(result.entry.reason).toContain('tools/Dockerfile.dev (node:20) says 20')
  })

  it('ignores floating pins and minimum versions', () => {
    expect(node({ Dockerfile: 'FROM node:22\n', '.nvmrc': 'lts/*\n' })!.entry.result).toBe('pass')
    const rust = evaluateRuntimePins(
      pinsOf({
        'Cargo.toml': '[package]\nname = "kestrel-cli"\nrust-version = "1.70"\n',
        'rust-toolchain.toml': '[toolchain]\nchannel = "1.80"\n',
      }),
      'rust',
    )!
    expect(rust.entry.result).toBe('pass')
    expect(rust.entry.pins.map((p) => p.source)).toEqual(['rust_toolchain'])
    expect(
      evaluateRuntimePins(
        pinsOf({ 'Cargo.toml': '[package]\nname = "x"\nrust-version = "1.70"\n' }),
        'rust',
      ),
    ).toBeNull()
  })

  it('compares Bun pins on major and minor', () => {
    const manifest = JSON.stringify({ name: 'kestrel-web', packageManager: 'bun@1.1.8' })
    const result = evaluateRuntimePins(
      pinsOf({ 'package.json': manifest, Dockerfile: 'FROM oven/bun:1.2\n' }, ['Dockerfile']),
      'bun',
    )!
    expect(result.entry).toMatchObject({ result: 'warn', productionLine: '1.2' })
  })
})

describe('the guard', () => {
  const repo = (id: number) => ({ id, owner: 'kestrel-co', name: `repo-${id}` }) as RepoRow

  it('runs without support data and leaves repos whose pins were never read alone', async () => {
    const pins = pinsOf({
      Dockerfile: 'FROM node:26\n',
      '.github/workflows/ci.yml': setupNodeWorkflow({ test: '22' }),
    })
    const ctx: GuardContext = {
      deployments: [],
      repos: [repo(1), repo(2), repo(3)],
      index: { deployments: [], byRepo: new Map(), unmapped: [] },
      scans: new Map([
        [1, { repo: repo(1), pins: { ref: 'main', pins, error: null } } as unknown as RepoScan],
        [2, { repo: repo(2), pins: { ref: 'main', pins: [], error: null } } as unknown as RepoScan],
        [3, { repo: repo(3), pins: null } as unknown as RepoScan],
      ]),
      support: null,
      supportWindowDays: 90,
      behindReleases: { rust: 4, bun: 4 },
      repoFiles: noRepoFiles(),
      now: RUNTIME_NOW,
    }
    const results = await runtimePinsDisagreeGuard.run(ctx)
    expect(results.map((r) => [r.subject, r.level])).toEqual([
      [{ repoId: 1 }, 'warn'],
      [{ repoId: 2 }, 'pass'],
    ])
    const evidence = runtimePinsDisagreeEvidenceSchema.parse(evidenceOf(results[0]!))
    expect(evidence.runtimes).toHaveLength(1)
    expect(evidence.runtimes[0]!.pins).toHaveLength(2)
  })
})
