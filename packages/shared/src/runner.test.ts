import { describe, expect, it } from 'vitest'
import {
  FINDING_TIERS,
  fixPlanSchema,
  type FindingTier,
  type FixPlan,
  type FixPlanStep,
} from './api.js'
import {
  CHECK_OUTPUT_MAX_CHARS,
  CHECK_OUTPUT_MAX_LINES,
  FIX_DISPATCH_SCHEMA,
  FIX_RESULT_SCHEMA,
  FixPayloadError,
  FIX_MAJORS_MAX_STEPS,
  fixDispatchStepSchema,
  isMajorStep,
  isSafeRepoPath,
  parseFixDispatch,
  parseFixPlan,
  parseFixResult,
  toFixDispatch,
  truncateCheckOutput,
  type FixDispatchV1,
  type FixResultV1,
} from './runner.js'
import {
  FIX_DISPATCH_PAYLOAD_BUDGET,
  WORKFLOW_DISPATCH_INPUT_LIMIT,
  decodeFixDispatch,
  encodeFixDispatch,
  type FixPayloadCompressor,
} from './runner-payload.js'
import { MAJORS_BRANCH, renderMajorsPrBody } from './runner-majors.js'
import { renderFixPrBody } from './runner-pr.js'
import { renderCallerWorkflow } from './runner-setup.js'
import { FIX_RUN_BRANCHES } from './fix-runs.js'

// Fictional repos of the kestrel-co org and made up packages only.

const NOW = new Date('2026-11-07T10:00:00.000Z')
const BASE_SHA = 'a'.repeat(40)

// gzip through the Web Streams globals of the test runtime. The shared package itself takes
// the compressor as a parameter and never touches a platform API.
interface WebGlobals {
  CompressionStream: new (format: 'gzip') => object
  DecompressionStream: new (format: 'gzip') => object
  Blob: new (parts: unknown[]) => { stream(): { pipeThrough(transform: object): unknown } }
  Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }
  btoa(binary: string): string
  atob(base64: string): string
}
const web = globalThis as unknown as WebGlobals

const compressor: FixPayloadCompressor = {
  async compress(text) {
    const stream = new web.Blob([text]).stream().pipeThrough(new web.CompressionStream('gzip'))
    const bytes = new Uint8Array(await new web.Response(stream).arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return web.btoa(binary)
  },
  async decompress(base64) {
    const bytes = Uint8Array.from(web.atob(base64), (c) => c.charCodeAt(0))
    const stream = new web.Blob([bytes]).stream().pipeThrough(new web.DecompressionStream('gzip'))
    return new web.Response(stream).text()
  },
}

function tiers(partial: Partial<Record<FindingTier, number>>): Record<FindingTier, number> {
  return Object.fromEntries(FINDING_TIERS.map((t) => [t, partial[t] ?? 0])) as Record<
    FindingTier,
    number
  >
}

function step(overrides: Partial<FixPlanStep> & Pick<FixPlanStep, 'id' | 'order'>): FixPlanStep {
  return {
    ecosystem: 'npm',
    packageName: 'plover-parse',
    relationship: 'direct',
    lockfile: 'pnpm-lock.yaml',
    packageManager: 'pnpm',
    workspaces: ['.'],
    via: [],
    findingIds: [1],
    advisories: ['GHSA-plov-0001-aaaa'],
    byTier: tiers({ dev: 1 }),
    from: ['1.2.0'],
    to: '1.3.0',
    level: 'minor',
    risk: 'safe',
    riskReasons: [],
    note: null,
    apply: {
      type: 'manifest_bump',
      manifests: ['package.json'],
      packageName: 'plover-parse',
      version: '1.3.0',
    },
    releasedAt: null,
    releaseAge: 'unknown',
    ...overrides,
  }
}

function plan(steps: FixPlanStep[], extra: Partial<FixPlan> = {}): FixPlan {
  return fixPlanSchema.parse({
    version: 1,
    repo: {
      id: 7,
      owner: 'kestrel-co',
      name: 'harbor',
      fullName: 'kestrel-co/harbor',
      archived: false,
      alertsEnabled: true,
      lastScannedAt: '2026-11-07T09:00:00.000Z',
    },
    scanRunId: 42,
    createdAt: '2026-11-07T09:00:00.000Z',
    projects: [
      {
        lockfile: 'pnpm-lock.yaml',
        root: '.',
        packageManager: 'pnpm',
        workspaces: ['.', 'apps/api'],
      },
    ],
    steps,
    unfixed: [
      {
        ecosystem: 'npm',
        packageName: 'pad-ng',
        relationship: 'transitive',
        lockfile: 'pnpm-lock.yaml',
        packageManager: 'pnpm',
        workspaces: [],
        via: ['heron-ui'],
        findingIds: [9],
        advisories: ['GHSA-padn-0001-dddd'],
        byTier: tiers({ not_deployed: 1 }),
        installed: ['0.4.1'],
        blocker: 'no_patch',
        availableAt: null,
      },
    ],
    summary: {
      findings: {
        total: 9,
        cleared: 8,
        clearedSafely: 6,
        unfixed: 1,
        clearedByTier: tiers({}),
        unfixedByTier: tiers({}),
      },
      steps: { safe: 3, risky: 1 },
      unfixed: 1,
    },
    previous: null,
    ...extra,
  })
}

const harborSteps: FixPlanStep[] = [
  step({
    id: 'manifest_bump:npm:plover-parse:1.3.0:pnpm-lock.yaml',
    order: 1,
    workspaces: ['.', 'apps/api'],
    findingIds: [1, 2, 3],
    advisories: ['GHSA-plov-0001-aaaa', 'GHSA-plov-0002-aaaa'],
    byTier: tiers({ exposed: 2, internal: 1 }),
    apply: {
      type: 'manifest_bump',
      manifests: ['package.json', 'apps/api/package.json'],
      packageName: 'plover-parse',
      version: '1.3.0',
    },
  }),
  step({
    id: 'override:npm:wren-dom:2.1.4:pnpm-lock.yaml',
    order: 2,
    packageName: 'wren-dom',
    relationship: 'transitive',
    workspaces: [],
    via: ['plover-parse'],
    findingIds: [4],
    advisories: ['GHSA-wren-0001-bbbb'],
    byTier: tiers({ dev: 1 }),
    from: ['2.1.0'],
    to: '2.1.4',
    level: 'patch',
    apply: {
      type: 'override',
      manifest: 'package.json',
      field: 'pnpm.overrides',
      key: 'wren-dom',
      value: '2.1.4',
    },
  }),
  step({
    id: 'manifest_bump:npm:gull-log:0.2.3:',
    order: 3,
    packageName: 'gull-log',
    lockfile: null,
    findingIds: [5],
    advisories: ['GHSA-gull-0001-cccc'],
    from: ['0.2.1'],
    to: '0.2.3',
    level: 'patch',
    apply: {
      type: 'manifest_bump',
      manifests: ['package.json'],
      packageName: 'gull-log',
      version: '0.2.3',
    },
  }),
  step({
    id: 'manifest_bump:npm:heron-ui:4.0.1:pnpm-lock.yaml',
    order: 4,
    packageName: 'heron-ui',
    findingIds: [6, 7],
    advisories: ['GHSA-hern-0001-eeee'],
    byTier: tiers({ public_low: 2 }),
    from: ['3.4.0'],
    to: '4.0.1',
    level: 'major',
    risk: 'risky',
    riskReasons: ['semver_major'],
    note: 'Semver major: read the changelog',
    apply: {
      type: 'manifest_bump',
      manifests: ['package.json'],
      packageName: 'heron-ui',
      version: '4.0.1',
    },
  }),
]

const harbor = plan(harborSteps)

function result(overrides: Partial<FixResultV1> = {}): FixResultV1 {
  return parseFixResult({
    schema: FIX_RESULT_SCHEMA,
    runId: 'run-0001',
    planScanRunId: 42,
    repo: 'kestrel-co/harbor',
    baseSha: BASE_SHA,
    packageManager: 'pnpm',
    packageManagerVersion: '10.20.0',
    checksMode: 'full',
    steps: [
      {
        id: harborSteps[0]!.id,
        status: 'applied',
        reason: null,
        detail: null,
        files: ['package.json', 'apps/api/package.json'],
      },
      {
        id: harborSteps[1]!.id,
        status: 'applied',
        reason: null,
        detail: null,
        files: ['package.json'],
      },
    ],
    releaseAge: [],
    install: { status: 'ok', durationMs: 31_000, output: null, truncated: false },
    checks: [
      {
        name: 'lint',
        command: 'pnpm lint',
        status: 'passed',
        durationMs: 12_000,
        output: null,
        truncated: false,
      },
      {
        name: 'test',
        command: 'pnpm test',
        status: 'passed',
        durationMs: 75_000,
        output: null,
        truncated: false,
      },
    ],
    patch: {
      sha256: 'b'.repeat(64),
      files: ['package.json', 'apps/api/package.json', 'pnpm-lock.yaml'],
      insertions: 12,
      deletions: 9,
    },
    finishedAt: '2026-11-07T10:05:00.000Z',
    ...overrides,
  })
}

function expectPayloadError(run: () => unknown, code: FixPayloadError['code']) {
  expect(run).toThrow(FixPayloadError)
  expect(run).toThrow(expect.objectContaining({ code }) as Error)
}

async function expectPayloadRejection(promise: Promise<unknown>, code: FixPayloadError['code']) {
  await expect(promise).rejects.toBeInstanceOf(FixPayloadError)
  await expect(promise).rejects.toMatchObject({ code })
}

describe('toFixDispatch', () => {
  it('sends only the safe steps the runner can apply, in order', () => {
    const dispatch = toFixDispatch(harbor, {
      runId: 'run-0001',
      baseBranch: 'main',
      visibility: 'public',
      now: NOW,
    })
    expect(dispatch.schema).toBe(FIX_DISPATCH_SCHEMA)
    expect(dispatch.dispatchedAt).toBe(NOW.toISOString())
    expect(dispatch.plan).toEqual({ version: 1, scanRunId: 42, createdAt: harbor.createdAt })
    expect(dispatch.repo).toEqual({ id: 7, fullName: 'kestrel-co/harbor', baseBranch: 'main' })
    expect(dispatch.steps.map((s) => s.packageName)).toEqual(['plover-parse', 'wren-dom'])
    expect(dispatch.steps[0]?.tier).toBe('exposed')
    expect(dispatch.steps[1]?.apply).toEqual(harborSteps[1]!.apply)
    expect(dispatch.risky).toEqual([])
    expect(dispatch.omitted).toEqual({ steps: 0, risky: 0, advisories: false })
  })

  it('picks full checks and no links for public repos, install and links for private ones', () => {
    const base = { runId: 'run-0001', baseBranch: 'main', now: NOW }
    const pub = toFixDispatch(harbor, { ...base, visibility: 'public' })
    const priv = toFixDispatch(harbor, { ...base, visibility: 'private' })
    expect(pub.options).toEqual({
      checks: 'full',
      agent: false,
      linksAllowed: false,
      releaseAgeDays: 7,
    })
    expect(priv.options).toEqual({
      checks: 'install',
      agent: false,
      linksAllowed: true,
      releaseAgeDays: 7,
    })
    expect(
      toFixDispatch(harbor, { ...base, visibility: 'private', checks: 'full' }).options.checks,
    ).toBe('full')
  })

  it('lists risky steps for the majors job only when the agent is on', () => {
    const dispatch = toFixDispatch(harbor, {
      runId: 'run-0001',
      baseBranch: 'main',
      visibility: 'private',
      agent: true,
      now: NOW,
    })
    expect(dispatch.options.agent).toBe(true)
    expect(dispatch.risky).toHaveLength(1)
    expect(dispatch.risky[0]).toMatchObject({
      packageName: 'heron-ui',
      from: ['3.4.0'],
      to: '4.0.1',
      riskReasons: ['semver_major'],
      note: 'Semver major: read the changelog',
    })
    expect(dispatch.steps.some((s) => s.packageName === 'heron-ui')).toBe(false)
  })

  it('refuses a plan version it does not know', () => {
    const future = { ...harbor, version: 2 } as unknown as FixPlan
    expectPayloadError(
      () => toFixDispatch(future, { runId: 'r', baseBranch: 'main', visibility: 'public' }),
      'unsupported_version',
    )
    expectPayloadError(() => parseFixPlan({ version: 'one' }), 'unsupported_version')
  })

  it('carries cargo bumps by crate name with no manifests', () => {
    const cargo = plan([
      step({
        id: 'manifest_bump:rust:tern-codec:0.9.2:Cargo.lock',
        order: 1,
        ecosystem: 'rust',
        packageName: 'tern-codec',
        lockfile: 'Cargo.lock',
        packageManager: 'cargo',
        workspaces: ['harbor-api'],
        from: ['0.9.0'],
        to: '0.9.2',
        level: 'patch',
        apply: {
          type: 'manifest_bump',
          manifests: [],
          packageName: 'tern-codec',
          version: '0.9.2',
        },
      }),
    ])
    const dispatch = toFixDispatch(cargo, { runId: 'r', baseBranch: 'main', visibility: 'public' })
    expect(dispatch.steps[0]?.workspaces).toEqual(['harbor-api'])
    expect(dispatch.steps[0]?.apply).toMatchObject({ type: 'manifest_bump', manifests: [] })
  })
})

describe('dispatch step validation', () => {
  const valid = toFixDispatch(harbor, { runId: 'r', baseBranch: 'main', visibility: 'public' })
    .steps[0]!

  it('accepts a projected step', () => {
    expect(fixDispatchStepSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    ['a range as the target', { to: '^1.3.0' }],
    ['a url as the target', { to: 'https://example.dev/x.tgz' }],
    ['a manifest outside the repo', { apply: { ...valid.apply, manifests: ['../package.json'] } }],
    [
      'a manifest under .github',
      { apply: { ...valid.apply, manifests: ['.github/package.json'] } },
    ],
    ['a file that is not a manifest', { apply: { ...valid.apply, manifests: ['src/index.ts'] } }],
    [
      'a package name with shell syntax',
      { packageName: 'plover;rm', apply: { ...valid.apply, packageName: 'plover;rm' } },
    ],
    ['an apply for another package', { apply: { ...valid.apply, packageName: 'wren-dom' } }],
    ['an npm bump with no manifest', { apply: { ...valid.apply, manifests: [] } }],
  ])('rejects %s', (_label, change) => {
    expect(fixDispatchStepSchema.safeParse({ ...valid, ...change }).success).toBe(false)
  })

  it('rejects an override keyed for another package', () => {
    const override = toFixDispatch(harbor, { runId: 'r', baseBranch: 'main', visibility: 'public' })
      .steps[1]!
    const bad = { ...override, apply: { ...override.apply, key: 'gull-log' } }
    expect(fixDispatchStepSchema.safeParse(bad).success).toBe(false)
  })

  it('knows safe repo paths', () => {
    expect(isSafeRepoPath('.')).toBe(true)
    expect(isSafeRepoPath('apps/api/package.json')).toBe(true)
    for (const bad of [
      '',
      '/etc/passwd',
      'a/../b',
      './a',
      'a//b',
      'a\\b',
      '.github/workflows/x.yml',
    ]) {
      expect(isSafeRepoPath(bad)).toBe(false)
    }
  })
})

describe('parseFixDispatch and parseFixResult', () => {
  const dispatch = toFixDispatch(harbor, { runId: 'r', baseBranch: 'main', visibility: 'public' })

  it('accepts what toFixDispatch builds', () => {
    expect(parseFixDispatch(JSON.parse(JSON.stringify(dispatch)))).toEqual(dispatch)
  })

  it('refuses an unknown dispatch schema or plan version', () => {
    expectPayloadError(
      () => parseFixDispatch({ ...dispatch, schema: 'hinomi.fix-dispatch/2' }),
      'unsupported_version',
    )
    expectPayloadError(
      () => parseFixDispatch({ ...dispatch, plan: { ...dispatch.plan, version: 2 } }),
      'unsupported_version',
    )
    expectPayloadError(() => parseFixDispatch(null), 'unsupported_version')
  })

  it('reports where a dispatch is malformed', () => {
    const bad = { ...dispatch, repo: { ...dispatch.repo, fullName: 'not a repo' } }
    expect(() => parseFixDispatch(bad)).toThrow(/repo\.fullName/)
    expectPayloadError(() => parseFixDispatch(bad), 'malformed')
  })

  it('refuses an unknown result schema', () => {
    expectPayloadError(
      () => parseFixResult({ ...result(), schema: 'hinomi.fix-result/9' }),
      'unsupported_version',
    )
  })
})

function bigPlan(size: number): FixPlan {
  const steps = Array.from({ length: size }, (_, i) =>
    step({
      id: `manifest_bump:npm:kestrel-pkg-${i}:1.0.${i + 1}:pnpm-lock.yaml`,
      order: i + 1,
      packageName: `kestrel-pkg-${i}`,
      findingIds: [i + 1],
      advisories: Array.from({ length: 8 }, (_, j) => `GHSA-k${i}-${j}-aaaa-bbbb`),
      byTier: i % 10 === 0 ? tiers({ exposed: 1 }) : tiers({ dev: 1 }),
      from: ['1.0.0'],
      to: `1.0.${i + 1}`,
      level: 'patch',
      apply: {
        type: 'manifest_bump',
        manifests: ['package.json', 'apps/api/package.json'],
        packageName: `kestrel-pkg-${i}`,
        version: `1.0.${i + 1}`,
      },
    }),
  )
  const risky = step({
    id: 'manifest_bump:npm:heron-ui:4.0.1:pnpm-lock.yaml',
    order: size + 1,
    packageName: 'heron-ui',
    risk: 'risky',
    riskReasons: ['semver_major'],
    from: ['3.4.0'],
    to: '4.0.1',
    level: 'major',
    apply: {
      type: 'manifest_bump',
      manifests: ['package.json'],
      packageName: 'heron-ui',
      version: '4.0.1',
    },
  })
  return plan([...steps, risky])
}

describe('encodeFixDispatch and decodeFixDispatch', () => {
  const options = {
    runId: 'run-0002',
    baseBranch: 'main',
    visibility: 'private' as const,
    agent: true,
    now: NOW,
  }

  it('sends plain JSON below the threshold and round trips it', async () => {
    const dispatch = toFixDispatch(harbor, options)
    const encoded = await encodeFixDispatch(dispatch, { compressor })
    expect(encoded.encoding).toBe('json')
    expect(encoded.omittedStepIds).toEqual([])
    expect(await decodeFixDispatch(encoded.payload, encoded.encoding, { compressor })).toEqual(
      dispatch,
    )
  })

  it('switches to gzip plus base64 above the threshold and round trips it', async () => {
    const dispatch = toFixDispatch(bigPlan(200), options)
    expect(JSON.stringify(dispatch).length).toBeGreaterThan(FIX_DISPATCH_PAYLOAD_BUDGET)
    const encoded = await encodeFixDispatch(dispatch, { compressor })
    expect(encoded.encoding).toBe('gzip-base64')
    expect(encoded.payload.length).toBeLessThanOrEqual(FIX_DISPATCH_PAYLOAD_BUDGET)
    expect(encoded.dispatch).toBe(dispatch)
    expect(await decodeFixDispatch(encoded.payload, encoded.encoding, { compressor })).toEqual(
      dispatch,
    )
  })

  it('drops risky entries, then advisories, then the least urgent steps before failing', async () => {
    const dispatch = toFixDispatch(bigPlan(200), options)
    const budget = 4_000
    const encoded = await encodeFixDispatch(dispatch, { compressor, budget })
    const sent = encoded.dispatch
    expect(encoded.payload.length).toBeLessThanOrEqual(budget)
    expect(sent.risky).toEqual([])
    expect(sent.omitted.risky).toBe(1)
    expect(sent.omitted.advisories).toBe(true)
    expect(sent.steps.every((s) => s.advisories.length === 0)).toBe(true)
    expect(sent.steps.length).toBeGreaterThan(0)
    expect(sent.omitted.steps).toBe(200 - sent.steps.length)
    expect(encoded.omittedStepIds).toHaveLength(sent.omitted.steps)
    // The 20 exposed steps outrank the dev ones, and kept steps stay in plan order.
    const exposedKept = sent.steps.filter((s) => s.tier === 'exposed').length
    expect(exposedKept).toBe(Math.min(20, sent.steps.length))
    const orders = sent.steps.map((s) => s.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(await decodeFixDispatch(encoded.payload, encoded.encoding, { compressor })).toEqual(sent)
  })

  it('fails with too_large when not even one step fits', async () => {
    const dispatch = toFixDispatch(bigPlan(5), options)
    await expectPayloadRejection(
      encodeFixDispatch(dispatch, { compressor, budget: 200 }),
      'too_large',
    )
  })

  it('rejects bad inputs on decode', async () => {
    await expectPayloadRejection(decodeFixDispatch('{}', 'brotli', { compressor }), 'malformed')
    await expectPayloadRejection(decodeFixDispatch('not json', 'json', { compressor }), 'malformed')
    await expectPayloadRejection(
      decodeFixDispatch('bm90IGd6aXA=', 'gzip-base64', { compressor }),
      'malformed',
    )
    const huge = 'x'.repeat(WORKFLOW_DISPATCH_INPUT_LIMIT + 1)
    await expectPayloadRejection(decodeFixDispatch(huge, 'json', { compressor }), 'too_large')
    const future: FixDispatchV1 = { ...toFixDispatch(harbor, options) }
    const payload = JSON.stringify({ ...future, schema: 'hinomi.fix-dispatch/2' })
    await expectPayloadRejection(
      decodeFixDispatch(payload, 'json', { compressor }),
      'unsupported_version',
    )
  })
})

describe('truncateCheckOutput', () => {
  it('keeps the last lines and scrubs token shapes', () => {
    const token = 'ghp_' + 'Z'.repeat(36)
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    lines.push(`auth failed for ${token}`)
    const { output, truncated } = truncateCheckOutput(lines.join('\n'))
    expect(truncated).toBe(true)
    expect(output.split('\n')).toHaveLength(CHECK_OUTPUT_MAX_LINES)
    expect(output).not.toContain(token)
    expect(output.endsWith('auth failed for ***')).toBe(true)
  })

  it('caps the characters and leaves short output whole', () => {
    expect(truncateCheckOutput('x'.repeat(10_000)).output).toHaveLength(CHECK_OUTPUT_MAX_CHARS)
    expect(truncateCheckOutput('ok\n')).toEqual({ output: 'ok', truncated: false })
  })
})

describe('renderFixPrBody', () => {
  it('renders a ready PR when every check passed', () => {
    const pr = renderFixPrBody(harbor, result(), {
      linksAllowed: false,
      hinomiUrl: 'https://hinomi.example.dev/fix-runs/1',
    })
    expect(pr.draft).toBe(false)
    expect(pr.title).toBe('fix(deps): clear 4 findings in 2 packages (2 exposed)')
    expect(pr.body).toContain(
      'Hinomi applied 2 of 3 safe upgrade steps from the fix plan of scan 42',
    )
    expect(pr.body).toContain('### Findings cleared')
    expect(pr.body).toContain('| Exposed | 2 |')
    expect(pr.body).toContain('| Dev dependency | 1 |')
    expect(pr.body).toContain('`GHSA-plov-0001-aaaa`')
    expect(pr.body).toContain(
      '| 1 | `plover-parse` | 1.2.0 | 1.3.0 | bump | pnpm-lock.yaml | Applied |',
    )
    expect(pr.body).toContain(
      '| 2 | `wren-dom` | 2.1.0 | 2.1.4 | override | pnpm-lock.yaml | Applied |',
    )
    expect(pr.body).toContain(
      '| 3 | `gull-log` | 0.2.1 | 0.2.3 | bump | no lockfile | Not sent: needs a person |',
    )
    expect(pr.body).toContain('### Risky upgrades, not applied')
    expect(pr.body).toContain('| `heron-ui` | 3.4.0 | 4.0.1 | Semver major: read the changelog |')
    expect(pr.body).toContain(
      '| `pad-ng` | 0.4.1 | No patched version yet | `GHSA-padn-0001-dddd` |',
    )
    expect(pr.body).toContain('| test | `pnpm test` | passed | 1 min 15 s |')
    expect(pr.body).not.toContain('### Failed checks')
    expect(pr.body).toContain('<!-- hinomi:fix repo=7 plan=42 run=run-0001 schema=1 -->')
    expect(pr.body).not.toMatch(/https?:\/\//)
    expect(pr.body).not.toMatch(new RegExp(String.fromCharCode(0x2013, 0x7c, 0x2014)))
  })

  it('links back to Hinomi only when links are allowed', () => {
    const url = 'https://hinomi.example.dev/fix-runs/1'
    expect(
      renderFixPrBody(harbor, result(), { linksAllowed: true, hinomiUrl: url }).body,
    ).toContain(`[Open this fix run in Hinomi](${url})`)
    expect(renderFixPrBody(harbor, result(), { linksAllowed: true }).body).not.toContain('](')
  })

  it('names the closed fix PR it replaces', () => {
    const body = renderFixPrBody(harbor, result(), { linksAllowed: false, replaces: 12 }).body
    expect(body).toContain('Replaces #12, which was closed without merging.')
    expect(renderFixPrBody(harbor, result(), { linksAllowed: false }).body).not.toContain(
      'Replaces',
    )
  })

  it('renders a draft with the failure output when a check failed', () => {
    const token = 'npm_' + 'Q'.repeat(36)
    const tail = truncateCheckOutput(`FAIL harbor.test.ts\n\`\`\`\nexpected 2\n\`\`\`\n${token}`)
    const failing = result({
      steps: [
        {
          id: harborSteps[0]!.id,
          status: 'applied',
          reason: null,
          detail: null,
          files: ['package.json'],
        },
        {
          id: harborSteps[1]!.id,
          status: 'skipped',
          reason: 'too_new',
          detail: null,
          files: [],
        },
      ],
      releaseAge: [
        {
          stepId: harborSteps[1]!.id,
          packageName: 'wren-dom',
          version: '2.1.4',
          publishedAt: '2026-11-05T00:00:00.000Z',
          gateDays: 7,
          gateSource: 'pnpm-workspace.yaml',
          status: 'too_new',
          eligibleAt: '2026-11-12T00:00:00.000Z',
        },
      ],
      checks: [
        {
          name: 'lint',
          command: 'pnpm lint',
          status: 'passed',
          durationMs: 9_000,
          output: null,
          truncated: false,
        },
        { name: 'test', command: 'pnpm test', status: 'failed', durationMs: 40_000, ...tail },
      ],
    })
    const pr = renderFixPrBody(harbor, failing, { linksAllowed: false })
    expect(pr.draft).toBe(true)
    expect(pr.title).toBe('fix(deps): clear 3 findings in 1 package (2 exposed)')
    expect(pr.body).toContain('> [!WARNING]')
    expect(pr.body).toContain('Skipped: too new for the release age gate, eligible on 2026-11-12')
    expect(pr.body).toContain('### Failed checks')
    expect(pr.body).toContain('<summary>test: failed</summary>')
    expect(pr.body).toContain('````text\nFAIL harbor.test.ts')
    expect(pr.body).not.toContain(token)
  })

  it('says the repo CI runs the checks in install mode', () => {
    const pr = renderFixPrBody(harbor, result({ checksMode: 'install', checks: [] }), {
      linksAllowed: true,
    })
    expect(pr.body).toContain('The runner only installed dependencies (install passed)')
    expect(pr.draft).toBe(false)
  })

  it('drafts the PR when the install failed', () => {
    const failed = result({
      checksMode: 'install',
      checks: [],
      install: {
        status: 'failed',
        durationMs: 5_000,
        output: 'ERR_PNPM_NO_MATCHING_VERSION',
        truncated: false,
      },
    })
    const pr = renderFixPrBody(harbor, failed, { linksAllowed: false })
    expect(pr.draft).toBe(true)
    expect(pr.body).toContain('<summary>install: failed</summary>')
  })

  it('refuses a result for another plan', () => {
    expectPayloadError(
      () => renderFixPrBody(harbor, result({ planScanRunId: 41 }), { linksAllowed: false }),
      'mismatch',
    )
  })
})

describe('majors dispatch', () => {
  const base = { runId: 'run-0002', baseBranch: 'main', visibility: 'public' as const, now: NOW }

  it('takes risky semver majors with a lockfile and a known package manager', () => {
    expect(isMajorStep(harborSteps[3]!)).toBe(true)
    expect(isMajorStep(harborSteps[0]!)).toBe(false)
    expect(isMajorStep({ ...harborSteps[3]!, lockfile: null })).toBe(false)
    expect(isMajorStep({ ...harborSteps[3]!, packageManager: 'unknown' })).toBe(false)
    const pinned = {
      ...harborSteps[3]!,
      level: 'minor' as const,
      riskReasons: ['pins_other_versions' as const],
    }
    expect(isMajorStep(pinned)).toBe(false)
  })

  it('sends no safe step, only the majors, with the agent and its preset on', () => {
    const dispatch = toFixDispatch(harbor, { ...base, kind: 'majors' })
    expect(dispatch.steps).toEqual([])
    expect(dispatch.risky.map((r) => r.packageName)).toEqual(['heron-ui'])
    expect(dispatch.options).toMatchObject({ agent: true, agentPreset: 'claude-code' })
    expect(parseFixDispatch(dispatch)).toEqual(dispatch)
    const stub = toFixDispatch(harbor, { ...base, kind: 'majors', agentPreset: 'stub' })
    expect(stub.options.agentPreset).toBe('stub')
  })

  it('caps the majors it hands over and records the rest as omitted', () => {
    const majors = Array.from({ length: FIX_MAJORS_MAX_STEPS + 3 }, (_, i) =>
      step({
        id: `manifest_bump:npm:tern-${i}:2.0.0:pnpm-lock.yaml`,
        order: i + 1,
        packageName: `tern-${i}`,
        from: ['1.0.0'],
        to: '2.0.0',
        level: 'major',
        risk: 'risky',
        riskReasons: ['semver_major'],
        apply: {
          type: 'manifest_bump',
          manifests: ['package.json'],
          packageName: `tern-${i}`,
          version: '2.0.0',
        },
      }),
    )
    const dispatch = toFixDispatch(plan(majors), { ...base, kind: 'majors' })
    expect(dispatch.risky).toHaveLength(FIX_MAJORS_MAX_STEPS)
    expect(dispatch.omitted.risky).toBe(3)
  })

  it('keeps the fix dispatch free of a preset', () => {
    expect(toFixDispatch(harbor, base).options.agentPreset).toBeUndefined()
  })

  it('names the majors branch apart from the fix branch', () => {
    expect(FIX_RUN_BRANCHES.majors).toBe(MAJORS_BRANCH)
    expect(MAJORS_BRANCH).not.toBe(FIX_RUN_BRANCHES.fix)
  })
})

function majorsResult(overrides: Partial<FixResultV1> = {}): FixResultV1 {
  return result({
    runId: 'run-0002',
    checksMode: 'full',
    steps: [{ id: harborSteps[3]!.id, status: 'applied', reason: null, detail: null, files: [] }],
    install: { status: 'skipped', durationMs: 0, output: null, truncated: false },
    checks: [],
    patch: {
      sha256: 'c'.repeat(64),
      files: ['package.json', 'pnpm-lock.yaml', 'src/menu.ts'],
      insertions: 30,
      deletions: 12,
    },
    agent: {
      preset: 'claude-code',
      outcome: 'changed',
      detail: null,
      summary: 'Moved the menu to the heron-ui 4 Popover API. Tests pass.',
      durationMs: 410_000,
      turns: 23,
      costUsd: 1.42,
      refusedPaths: ['.github/workflows/ci.yml'],
    },
    ...overrides,
  })
}

describe('renderMajorsPrBody', () => {
  it('opens a draft that says an agent made the changes, without attribution', () => {
    const pr = renderMajorsPrBody(harbor, majorsResult(), { linksAllowed: false })
    expect(pr.draft).toBe(true)
    expect(pr.title).toBe('fix(deps): upgrade heron-ui to 4.0.1 with agent changes')
    expect(pr.body).toContain('An automated coding agent (Claude Code) wrote the changes')
    expect(pr.body).toContain('| `heron-ui` | 3.4.0 | 4.0.1 | pnpm-lock.yaml | Yes |')
    expect(pr.body).toContain('Turns: 23. Estimated cost: 1.42 USD.')
    expect(pr.body).toContain('Popover API')
    expect(pr.body).toContain('`.github/workflows/ci.yml`')
    expect(pr.body).toContain('3 files changed, 30 insertions, 12 deletions.')
    expect(pr.body).toContain('<!-- hinomi:majors repo=7 plan=42 run=run-0002 schema=1 -->')
    expect(pr.body).not.toMatch(/Generated with|Co-Authored-By/i)
    expect(pr.body).not.toContain('Open this run in Hinomi')
  })

  it('links back to Hinomi only when links are allowed', () => {
    const pr = renderMajorsPrBody(harbor, majorsResult(), {
      linksAllowed: true,
      hinomiUrl: 'https://hinomi.example.dev/fix-runs?sel=3',
    })
    expect(pr.body).toContain('(https://hinomi.example.dev/fix-runs?sel=3)')
  })

  it('refuses a result without an agent report or for another plan', () => {
    const plain = { ...majorsResult(), agent: undefined }
    expectPayloadError(() => renderMajorsPrBody(harbor, plain, { linksAllowed: false }), 'mismatch')
    expectPayloadError(
      () => renderMajorsPrBody(harbor, majorsResult({ planScanRunId: 9 }), { linksAllowed: false }),
      'mismatch',
    )
  })
})

describe('renderCallerWorkflow and the majors agent', () => {
  it('leaves the secret commented out while the agent is off', () => {
    const text = renderCallerWorkflow()
    expect(text).toContain(
      '    # secrets:\n    #   ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
    )
  })

  it('hands the secret over when the agent is on', () => {
    const text = renderCallerWorkflow({ majorsAgent: 'claude-code' })
    expect(text).toContain(
      '    secrets:\n      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n',
    )
  })
})
