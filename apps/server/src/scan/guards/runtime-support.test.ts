import { runtimeSupportEvidenceSchema, type RuntimeSupportEntry } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import type { RepoRow } from '../../db/schema.js'
import type { RepoScan } from '../collect.js'
import { evaluateRuntimeSupport, runtimeSupportGuard } from './runtime-support.js'
import { RUNTIME_NOW, pinsOf, runtimeSupportIndex, setupNodeWorkflow } from './runtime-testing.js'
import { noRepoFiles } from './testing.js'
import type { GuardContext, GuardSubjectResult } from './types.js'

const evidenceOf = (result: GuardSubjectResult) =>
  'evidence' in result ? result.evidence : undefined

// Fictional repos of kestrel-co, judged on 2027-02-15 against fictional support data.

const support = runtimeSupportIndex()
const options = { now: RUNTIME_NOW, windowDays: 90, behindReleases: { rust: 4, bun: 4 } }

function judge(files: Record<string, string>, deployed?: string[], opts = options) {
  return evaluateRuntimeSupport(pinsOf(files, deployed), support, opts)
}

function only(entries: RuntimeSupportEntry[]): RuntimeSupportEntry {
  expect(entries).toHaveLength(1)
  return entries[0]!
}

describe('Node: end of security support', () => {
  it('fails Node 18 on the deployed Dockerfile and hints every file that pins it', () => {
    const entry = only(
      judge(
        {
          'apps/api/Dockerfile': 'FROM node:18-alpine AS build\nFROM node:18-alpine\n',
          '.nvmrc': 'v18.20.4\n',
          'package.json': JSON.stringify({ name: 'kestrel-api', engines: { node: '>=18' } }),
          '.github/workflows/ci.yml': setupNodeWorkflow({ test: '18' }),
        },
        ['apps/api/Dockerfile'],
      ),
    )
    expect(entry).toMatchObject({
      runtime: 'node',
      rule: 'support_window',
      result: 'fail',
      pin: { source: 'dockerfile', path: 'apps/api/Dockerfile', line: 2, raw: 'node:18-alpine' },
      support: { product: 'nodejs', line: '18', eolFrom: '2025-04-30', isEol: true },
      target: { line: '26', latest: '26.2.0' },
    })
    expect(entry.fixHints.map((h) => [h.path, h.line, h.from, h.to])).toEqual([
      ['apps/api/Dockerfile', 1, 'node:18-alpine', 'node:26-alpine'],
      ['apps/api/Dockerfile', 2, 'node:18-alpine', 'node:26-alpine'],
      ['.nvmrc', 1, 'v18.20.4', 'v26.2.0'],
      ['package.json', expect.any(Number), '>=18', '>=26'],
      ['.github/workflows/ci.yml', expect.any(Number), '18', '26'],
    ])
  })

  it('warns Node 22 inside the window and passes it outside', () => {
    const files = { '.nvmrc': '22\n' }
    expect(only(judge(files))).toMatchObject({
      result: 'warn',
      support: { line: '22', daysLeft: 73 },
      fixHints: [{ path: '.nvmrc', from: '22', to: '26' }],
    })
    expect(only(judge(files, undefined, { ...options, windowDays: 30 })).result).toBe('pass')
  })

  it('passes Node 26 with no hints', () => {
    const entry = only(judge({ Dockerfile: 'FROM node:26-slim\n' }))
    expect(entry).toMatchObject({ result: 'pass', support: { line: '26' }, fixHints: [] })
  })

  it('passes a floating pin and says what it resolves to', () => {
    expect(only(judge({ '.nvmrc': 'lts/*\n' }))).toMatchObject({
      result: 'pass',
      resolvedTo: '26',
      pin: { floating: true },
    })
  })

  it('is unknown for an unreadable pin and for a line the data does not have', () => {
    expect(only(judge({ Dockerfile: 'FROM node:${NODE}\n' })).result).toBe('unknown')
    const newer = only(judge({ '.nvmrc': '30\n' }))
    expect(newer.result).toBe('unknown')
    expect(newer.reason).toContain('not in the support data yet')
  })

  it('never lets a CI pin decide what production runs', () => {
    expect(judge({ '.github/workflows/ci.yml': setupNodeWorkflow({ test: '18' }) })).toEqual([])
  })
})

describe('Rust: behind the latest stable', () => {
  it('passes a floating channel', () => {
    const entry = only(judge({ 'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n' }))
    expect(entry).toMatchObject({
      runtime: 'rust',
      rule: 'behind_latest',
      result: 'pass',
      latest: '1.91.1',
    })
  })

  it('warns 1.80 when the latest is 1.91, and never fails', () => {
    const entry = only(
      judge({
        'rust-toolchain.toml': '[toolchain]\nchannel = "1.80.0"\n',
        Dockerfile: 'FROM rust:1.80-slim\n',
      }),
    )
    expect(entry).toMatchObject({
      result: 'warn',
      releasesBehind: 11,
      maxBehind: 4,
      support: null,
      target: { line: '1.91', latest: '1.91.1' },
    })
    expect(entry.fixHints.map((h) => [h.path, h.from, h.to])).toEqual([
      ['rust-toolchain.toml', '1.80.0', '1.91.1'],
      ['Dockerfile', 'rust:1.80-slim', 'rust:1.91-slim'],
    ])
  })

  it('passes a pin within N releases of the latest', () => {
    const files = { 'rust-toolchain': '1.88\n' }
    expect(only(judge(files))).toMatchObject({ result: 'pass', releasesBehind: 3 })
    const strict = { ...options, behindReleases: { rust: 2, bun: 4 } }
    expect(only(judge(files, undefined, strict)).result).toBe('warn')
  })

  it('ignores Cargo rust-version: a minimum is never the running toolchain', () => {
    const cargo = '[package]\nname = "kestrel-cli"\nrust-version = "1.60"\n'
    expect(judge({ 'Cargo.toml': cargo })).toEqual([])
    const entry = only(
      judge({ 'Cargo.toml': cargo, 'rust-toolchain.toml': '[toolchain]\nchannel = "1.82"\n' }),
    )
    expect(entry).toMatchObject({ result: 'warn', pin: { source: 'rust_toolchain' } })
    expect(entry.fixHints.map((h) => h.path)).toEqual(['rust-toolchain.toml'])
  })
})

describe('Bun: behind the latest minor', () => {
  it('passes latest and a major only pin', () => {
    expect(only(judge({ Dockerfile: 'FROM oven/bun:latest\n' }))).toMatchObject({
      runtime: 'bun',
      result: 'pass',
      resolvedTo: '1.5',
    })
    const manifest = JSON.stringify({ name: 'kestrel-web', packageManager: 'bun@1' })
    expect(only(judge({ 'package.json': manifest })).result).toBe('pass')
  })

  it('warns 1.0 five minor releases behind 1.5', () => {
    const manifest = JSON.stringify({ name: 'kestrel-web', packageManager: 'bun@1.0.25' })
    const entry = only(judge({ 'package.json': manifest }))
    expect(entry).toMatchObject({ result: 'warn', releasesBehind: 5, latest: '1.5.1' })
    expect(entry.fixHints).toEqual([
      expect.objectContaining({ path: 'package.json', from: 'bun@1.0.25', to: 'bun@1.5.1' }),
    ])
  })

  it('passes 1.1, exactly N behind', () => {
    expect(only(judge({ '.bun-version': '1.1.3\n' }))).toMatchObject({
      result: 'pass',
      releasesBehind: 4,
    })
  })
})

describe('the guard', () => {
  const repo = (id: number) => ({ id, owner: 'kestrel-co', name: `repo-${id}` }) as RepoRow
  const scan = (id: number, pins: RepoScan['pins']) =>
    ({ repo: repo(id), pins }) as unknown as RepoScan

  function context(over: Partial<GuardContext>): GuardContext {
    return {
      deployments: [],
      repos: [repo(1), repo(2), repo(3)],
      index: { deployments: [], byRepo: new Map(), unmapped: [] },
      scans: new Map([
        [1, scan(1, { ref: 'main', pins: pinsOf({ '.nvmrc': '18\n' }), error: null })],
        [2, scan(2, { ref: 'main', pins: [], error: 'GitHub said 502' })],
        [3, scan(3, null)],
      ]),
      support,
      supportWindowDays: 90,
      behindReleases: { rust: 4, bun: 4 },
      repoFiles: noRepoFiles(),
      now: RUNTIME_NOW,
      ...over,
    }
  }

  it('writes one finding per repo at the worst level, and leaves unread repos alone', async () => {
    const results = await runtimeSupportGuard.run(context({}))
    expect(results.map((r) => [r.subject, r.level])).toEqual([
      [{ repoId: 1 }, 'fail'],
      [{ repoId: 2 }, 'pass'],
    ])
    const evidence = runtimeSupportEvidenceSchema.parse(evidenceOf(results[0]!))
    expect(evidence).toMatchObject({ ref: 'main', reason: null })
    expect(runtimeSupportEvidenceSchema.parse(evidenceOf(results[1]!)).reason).toContain('502')
  })

  it('leaves every finding alone while there is no support data yet', async () => {
    expect(await runtimeSupportGuard.run(context({ support: null }))).toEqual([])
  })
})
