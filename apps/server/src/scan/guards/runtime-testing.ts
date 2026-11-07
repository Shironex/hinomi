import type { RuntimePinRecord } from '@hinomi/shared'
import { readRuntimePins } from '../../pins/index.js'
import { createSupportIndex, parseProductsFull, type SupportIndex } from '../../support/index.js'

// Test helpers for the runtime checks: fictional endoflife.date data and pins read from fictional
// repo files with the real readers. No network.

/** The day the runtime tests run on: Node 22 ends 2027-04-30, 73 whole days later. */
export const RUNTIME_NOW = new Date('2027-02-15T12:00:00.000Z')

function release(
  name: string,
  latest: string,
  over: { isLts?: boolean; eoasFrom?: string; eolFrom?: string; isEol?: boolean } = {},
) {
  return {
    name,
    label: name,
    releaseDate: null,
    isLts: over.isLts ?? false,
    ltsFrom: null,
    isEoas: null,
    eoasFrom: over.eoasFrom ?? null,
    isEol: over.isEol ?? false,
    eolFrom: over.eolFrom ?? null,
    latest: { name: latest, date: null },
  }
}

/** A `products/full` body with these products. */
function productsBody(...products: unknown[]): string {
  return JSON.stringify({
    schema_version: '1.2.1',
    generated_at: '2027-02-15T02:00:00+00:00',
    result: products,
  })
}

const RUST_LINES = Array.from({ length: 12 }, (_, i) => 91 - i).map((minor) =>
  release(`1.${minor}`, `1.${minor}.${minor === 91 ? 1 : 0}`, { isEol: minor !== 91 }),
)

/** Fictional support data: Node 18 to 26, Rust 1.80 to 1.91, Bun line 1 at 1.5.1. */
export function runtimeSupportBody(): string {
  return productsBody(
    {
      name: 'nodejs',
      label: 'Node.js',
      aliases: ['node'],
      labels: { eol: 'Security Support' },
      releases: [
        release('26', '26.2.0', { isLts: true, eoasFrom: '2027-10-20', eolFrom: '2029-04-30' }),
        release('25', '25.9.0', { eolFrom: '2026-06-01' }),
        release('24', '24.11.0', { isLts: true, eoasFrom: '2026-10-20', eolFrom: '2028-04-30' }),
        release('22', '22.21.0', { isLts: true, eoasFrom: '2025-10-21', eolFrom: '2027-04-30' }),
        release('20', '20.19.5', { isLts: true, eolFrom: '2026-04-30' }),
        release('18', '18.20.8', { isLts: true, eolFrom: '2025-04-30' }),
      ],
    },
    { name: 'rust', label: 'Rust', labels: { eol: 'Supported' }, releases: RUST_LINES },
    {
      name: 'bun',
      label: 'Bun',
      labels: { eol: 'Security Support' },
      releases: [release('1', '1.5.1')],
    },
  )
}

export function runtimeSupportIndex(body = runtimeSupportBody()): SupportIndex {
  return createSupportIndex(parseProductsFull(body))
}

/** Pins of a fictional repo, read from its files; `deployed` lists the deployed Dockerfiles. */
export function pinsOf(files: Record<string, string>, deployed?: string[]): RuntimePinRecord[] {
  return readRuntimePins(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    deployed ? { productionDockerfiles: new Set(deployed) } : {},
  )
}

/** A setup-node workflow with one job per entry: a single version or a matrix. */
export function setupNodeWorkflow(jobs: Record<string, string | string[]>): string {
  const lines = ['name: ci', 'on: push', 'jobs:']
  for (const [job, version] of Object.entries(jobs)) {
    lines.push(`  ${job}:`, '    runs-on: ubuntu-latest')
    if (Array.isArray(version)) {
      lines.push('    strategy:', '      matrix:', `        node: [${version.join(', ')}]`)
    }
    lines.push(
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      `          node-version: ${Array.isArray(version) ? '${{ matrix.node }}' : version}`,
    )
  }
  return `${lines.join('\n')}\n`
}
