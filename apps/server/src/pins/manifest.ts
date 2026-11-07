import type { RuntimePinRecord, RuntimePinSource } from '@hinomi/shared'
import { jsonKeyLines, jsonPath } from './locate.js'
import { makePin, runtimeOfToolName } from './pin.js'
import { readPinValue } from './value.js'

type Json = unknown

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** An own property of a parsed object; never anything inherited. */
function own(value: Json, key: string): Json {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
}

/**
 * `package.json`: `engines.node` and `engines.bun` (ranges), `devEngines` runtime and package
 * manager, `volta.node`, and `packageManager` when it is Bun. A `packageManager` of npm, pnpm or
 * yarn says nothing about the Node line.
 */
export function parsePackageJson(text: string, path: string): RuntimePinRecord[] {
  let json: Json
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return []
  }
  if (!isRecord(json)) return []
  const lines = jsonKeyLines(text)
  const pins: RuntimePinRecord[] = []
  const add = (
    runtime: 'node' | 'bun',
    source: RuntimePinSource,
    raw: Json,
    keyPath: (string | number)[],
    range: boolean,
  ) => {
    if (typeof raw !== 'string') return
    pins.push(
      makePin(
        { runtime, source, path, line: lines.get(jsonPath(...keyPath)) ?? null, raw, scope: 'dev' },
        readPinValue(runtime, raw, { range }),
      ),
    )
  }

  const volta = own(json, 'volta')
  add('node', 'volta', own(volta, 'node'), ['volta', 'node'], false)

  const manager = own(json, 'packageManager')
  if (typeof manager === 'string') {
    const match = /^bun@([^\s+]+)/.exec(manager.trim())
    if (match?.[1] !== undefined) {
      pins.push(
        makePin(
          {
            runtime: 'bun',
            source: 'package_manager',
            path,
            line: lines.get(jsonPath('packageManager')) ?? null,
            raw: manager,
            scope: 'dev',
          },
          readPinValue('bun', match[1]),
        ),
      )
    }
  }

  const dev = own(json, 'devEngines')
  const runtimeEntry = own(dev, 'runtime')
  const entries = Array.isArray(runtimeEntry) ? runtimeEntry : [runtimeEntry]
  entries.forEach((entry, index) => {
    const name = own(entry, 'name')
    const runtime = typeof name === 'string' ? runtimeOfToolName(name) : null
    if (runtime !== 'node' && runtime !== 'bun') return
    const keyPath = Array.isArray(runtimeEntry)
      ? ['devEngines', 'runtime', index, 'version']
      : ['devEngines', 'runtime', 'version']
    add(runtime, 'dev_engines', own(entry, 'version'), keyPath, true)
  })
  const devManager = own(dev, 'packageManager')
  if (own(devManager, 'name') === 'bun') {
    add(
      'bun',
      'dev_engines',
      own(devManager, 'version'),
      ['devEngines', 'packageManager', 'version'],
      true,
    )
  }

  const engines = own(json, 'engines')
  add('node', 'engines', own(engines, 'node'), ['engines', 'node'], true)
  add('bun', 'engines', own(engines, 'bun'), ['engines', 'bun'], true)
  return pins
}
