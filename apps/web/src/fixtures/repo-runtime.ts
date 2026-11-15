import type {
  OverviewWindow,
  RepoRuntimePin,
  RepoSupportLines,
  RuntimeSupportEntry,
  SupportLine,
} from '@hinomi/shared'
import { REPOS, ago } from './dataset'

// The runtime pins and support lines of the fixture repos (GET /api/repos/:id), and the lines
// that end soonest (GET /api/overview). Dates are those of the fixed clock, 5 November 2026, and
// agree with the runtime_support guard findings in ./guards. The warning window is 180 days.
// Node is judged by security end dates; Rust and Bun by releases behind the latest (decision
// Q12a), so they warn at most and have no date.

const SCANNED = ago(0.25)

type PinInput = Pick<RepoRuntimePin, 'runtime' | 'source' | 'path' | 'raw'> &
  Partial<Omit<RepoRuntimePin, 'runtime' | 'source' | 'path' | 'raw'>>

function pin(input: PinInput): RepoRuntimePin {
  return {
    line: 1,
    lineName: null,
    floating: false,
    kind: 'exact',
    version: input.raw,
    scope: 'dev',
    job: null,
    stage: null,
    finalStage: null,
    ref: 'main',
    scannedAt: SCANNED,
    disagrees: false,
    ...input,
  }
}

const nodeLine = (
  line: string,
  eolFrom: string,
  daysLeft: number,
  latest: string,
): SupportLine => ({
  product: 'nodejs',
  line,
  eolFrom,
  isEol: daysLeft < 0,
  isEoas: true,
  latest,
  basis: 'security',
  daysLeft,
})

const NODE_24 = nodeLine('24', '2028-04-30', 542, '24.11.0')
const NODE_22 = nodeLine('22', '2027-04-30', 176, '22.21.1')
const NODE_18 = nodeLine('18', '2025-04-30', -554, '18.20.8')

type EntryInput = Pick<RuntimeSupportEntry, 'runtime' | 'result' | 'pin'> &
  Partial<RuntimeSupportEntry>

function entry(input: EntryInput): RuntimeSupportEntry {
  return {
    support: null,
    resolvedTo: null,
    target: null,
    fixHints: [],
    rule: 'support_window',
    latest: null,
    releasesBehind: null,
    maxBehind: null,
    reason: null,
    ...input,
  }
}

const evidencePin = (p: RepoRuntimePin): RuntimeSupportEntry['pin'] => ({
  runtime: p.runtime,
  source: p.source,
  path: p.path,
  line: p.line,
  raw: p.raw,
  lineName: p.lineName,
  floating: p.floating,
})

const TARGET_24 = { line: '24', latest: '24.11.0' }

/** A repo that runs Node 24 from its Dockerfile and nothing else out of line. */
function currentNode(): { pins: RepoRuntimePin[]; entries: RuntimeSupportEntry[] } {
  const docker = pin({
    runtime: 'node',
    source: 'dockerfile',
    path: 'Dockerfile',
    raw: 'node:24-alpine',
    version: '24',
    lineName: '24',
    scope: 'production',
    stage: 0,
    finalStage: true,
  })
  return {
    pins: [
      docker,
      pin({ runtime: 'node', source: 'nvmrc', path: '.nvmrc', raw: '24', lineName: '24' }),
    ],
    entries: [
      entry({
        runtime: 'node',
        result: 'pass',
        pin: evidencePin(docker),
        support: NODE_24,
        target: TARGET_24,
        latest: '24.11.0',
      }),
    ],
  }
}

function ingest() {
  const docker = pin({
    runtime: 'node',
    source: 'dockerfile',
    path: 'Dockerfile',
    raw: 'node:18-alpine',
    version: '18',
    lineName: '18',
    scope: 'production',
    stage: 0,
    finalStage: true,
  })
  const nvmrc = pin({ runtime: 'node', source: 'nvmrc', path: '.nvmrc', raw: '18', lineName: '18' })
  const ci = pin({
    runtime: 'node',
    source: 'setup_node',
    path: '.github/workflows/ci.yml',
    line: 22,
    raw: 'node-version: 18',
    version: '18',
    lineName: '18',
    scope: 'ci',
    job: 'test',
  })
  return {
    pins: [ci, docker, nvmrc].sort((a, b) => a.path.localeCompare(b.path)),
    entries: [
      entry({
        runtime: 'node',
        result: 'fail',
        pin: evidencePin(docker),
        support: NODE_18,
        target: TARGET_24,
        latest: '24.11.0',
        fixHints: [
          { path: 'Dockerfile', line: 1, from: 'node:18-alpine', to: 'node:24-alpine' },
          { path: '.nvmrc', line: 1, from: '18', to: '24' },
          {
            path: '.github/workflows/ci.yml',
            line: 22,
            from: 'node-version: 18',
            to: 'node-version: 24',
          },
        ],
      }),
    ],
  }
}

/** Node 22 inside the window, a stale `.nvmrc` that disagrees, and Bun two releases behind. */
function storefront() {
  const docker = pin({
    runtime: 'node',
    source: 'dockerfile',
    path: 'Dockerfile',
    raw: 'node:22-bookworm-slim',
    version: '22',
    lineName: '22',
    scope: 'production',
    stage: 0,
    finalStage: true,
  })
  const nvmrc = pin({
    runtime: 'node',
    source: 'nvmrc',
    path: '.nvmrc',
    raw: '20',
    lineName: '20',
    disagrees: true,
  })
  const ci = pin({
    runtime: 'node',
    source: 'setup_node',
    path: '.github/workflows/ci.yml',
    line: 18,
    raw: 'node-version: 22',
    version: '22',
    lineName: '22',
    scope: 'ci',
    job: 'build',
  })
  const engines = pin({
    runtime: 'node',
    source: 'engines',
    path: 'package.json',
    line: 41,
    raw: '>=20',
    kind: 'range',
    version: '>=20',
    lineName: '20',
  })
  const manager = pin({
    runtime: 'bun',
    source: 'package_manager',
    path: 'package.json',
    line: 5,
    raw: 'bun@1.1.34',
    version: '1.1.34',
    lineName: '1.1',
  })
  return {
    pins: [ci, nvmrc, docker, engines, manager].sort(
      (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
    ),
    entries: [
      entry({
        runtime: 'node',
        result: 'warn',
        pin: evidencePin(docker),
        support: NODE_22,
        target: TARGET_24,
        latest: '24.11.0',
        fixHints: [
          {
            path: 'Dockerfile',
            line: 1,
            from: 'node:22-bookworm-slim',
            to: 'node:24-bookworm-slim',
          },
          { path: '.nvmrc', line: 1, from: '20', to: '24' },
          {
            path: '.github/workflows/ci.yml',
            line: 18,
            from: 'node-version: 22',
            to: 'node-version: 24',
          },
        ],
      }),
      entry({
        runtime: 'bun',
        result: 'pass',
        pin: evidencePin(manager),
        rule: 'behind_latest',
        target: { line: '1.3', latest: '1.3.2' },
        latest: '1.3.2',
        releasesBehind: 2,
        maxBehind: 4,
      }),
    ],
  }
}

/** A Rust CLI pinned by `rust-toolchain.toml`: nine releases behind warns and never fails. */
function cli() {
  const toolchain = pin({
    runtime: 'rust',
    source: 'rust_toolchain',
    path: 'rust-toolchain.toml',
    line: 2,
    raw: '1.82.0',
    version: '1.82.0',
    lineName: '1.82',
  })
  const minimum = pin({
    runtime: 'rust',
    source: 'cargo_rust_version',
    path: 'Cargo.toml',
    line: 5,
    raw: '1.74',
    kind: 'minimum',
    version: '1.74',
    lineName: '1.74',
  })
  const action = pin({
    runtime: 'rust',
    source: 'rust_toolchain_action',
    path: '.github/workflows/release.yml',
    line: 31,
    raw: 'dtolnay/rust-toolchain@stable',
    kind: 'floating',
    version: 'stable',
    lineName: '1.91',
    floating: true,
    scope: 'ci',
    job: 'build',
  })
  return {
    pins: [action, minimum, toolchain].sort((a, b) => a.path.localeCompare(b.path)),
    entries: [
      entry({
        runtime: 'rust',
        result: 'warn',
        pin: evidencePin(toolchain),
        rule: 'behind_latest',
        target: { line: '1.91', latest: '1.91.1' },
        latest: '1.91.1',
        releasesBehind: 9,
        maxBehind: 4,
        fixHints: [{ path: 'rust-toolchain.toml', line: 2, from: '1.82.0', to: '1.91.1' }],
        reason: 'Rust 1.82 is 9 stable releases behind the latest (1.91.1); it warns past 4.',
      }),
    ],
  }
}

/** A Node pin the support data does not know: listed, not judged. */
function auth() {
  const version = pin({
    runtime: 'node',
    source: 'node_version',
    path: '.node-version',
    raw: '25.9',
    version: '25.9',
    lineName: null,
    scope: 'dev',
    ref: 'release',
  })
  return {
    pins: [version],
    entries: [
      entry({
        runtime: 'node',
        result: 'unknown',
        pin: evidencePin(version),
        target: TARGET_24,
        latest: '24.11.0',
        reason:
          'Node 25.9 is not in the support data yet (a typo, or a line newer than the cached copy).',
      }),
    ],
  }
}

const RUNTIME_BY_REPO: Partial<
  Record<number, { pins: RepoRuntimePin[]; entries: RuntimeSupportEntry[] }>
> = {
  [REPOS.ingest.id]: ingest(),
  [REPOS.storefront.id]: storefront(),
  [REPOS.cli.id]: cli(),
  [REPOS.auth.id]: auth(),
  [REPOS.billing.id]: currentNode(),
  [REPOS.search.id]: currentNode(),
}

/** The pins and support lines GET /api/repos/:id serves; a repo with no pin has none. */
export function runtimeFor(id: number): {
  runtimePins: RepoRuntimePin[]
  supportLines: RepoSupportLines
} {
  const found = RUNTIME_BY_REPO[id]
  return {
    runtimePins: found?.pins ?? [],
    supportLines: { available: true, runtimes: found?.entries ?? [] },
  }
}

/** The runtime lines with an end date that end soonest, as GET /api/overview serves them. */
export function windowsFor(): OverviewWindow[] {
  const names = new Map(Object.values(REPOS).map((r) => [r.id, r.fullName]))
  return Object.entries(RUNTIME_BY_REPO)
    .flatMap(([id, found]) =>
      (found?.entries ?? []).flatMap((e) =>
        e.rule === 'support_window' && e.support?.eolFrom && e.support.daysLeft !== null
          ? [
              {
                repoId: Number(id),
                repoName: names.get(Number(id)) ?? `repo ${id}`,
                runtime: e.runtime,
                line: e.support.line,
                eolFrom: e.support.eolFrom,
                daysLeft: e.support.daysLeft,
                result: e.result,
              },
            ]
          : [],
      ),
    )
    .sort((a, b) => a.eolFrom.localeCompare(b.eolFrom) || a.repoName.localeCompare(b.repoName))
    .slice(0, 5)
}
