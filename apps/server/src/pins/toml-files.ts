import type { Runtime, RuntimePinRecord } from '@hinomi/shared'
import {
  asArray,
  asString,
  asTable,
  isTable,
  parseToml,
  type TomlValue,
} from '../sources/osv/lockfiles/toml.js'
import { tomlKeyLine, tomlRawValue } from './locate.js'
import { makePin, runtimeOfToolName } from './pin.js'
import { readPinValue } from './value.js'

function tryParse(text: string) {
  try {
    return parseToml(text)
  } catch {
    return null
  }
}

/** A TOML value as the text a pin reads: strings as they are, numbers from their own line. */
function valueText(value: TomlValue | undefined, text: string, line: number | null): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return tomlRawValue(text, line) ?? String(value)
  return null
}

/**
 * `mise.toml`: `[tools] node = "22"`, a list (the first is used) or a table with `version`.
 * Node, Bun and Rust only.
 */
export function parseMiseToml(text: string, path: string): RuntimePinRecord[] {
  const root = tryParse(text)
  if (!root) return []
  const tools = asTable(root['tools'])
  const pins: RuntimePinRecord[] = []
  const seen = new Set<Runtime>()
  for (const name of Object.keys(tools)) {
    const runtime = runtimeOfToolName(name)
    if (runtime === null || seen.has(runtime)) continue
    let value: TomlValue | undefined = tools[name]
    if (Array.isArray(value)) value = asArray(value)[0]
    if (isTable(value)) value = value['version']
    const line = tomlKeyLine(text, 'tools', name)
    const raw = valueText(value, text, line)
    if (raw === null) continue
    seen.add(runtime)
    pins.push(
      makePin(
        { runtime, source: 'mise', path, line, raw, scope: 'dev' },
        readPinValue(runtime, raw),
      ),
    )
  }
  return pins
}

/**
 * `rust-toolchain.toml`, or the older `rust-toolchain` file that is either TOML or a bare
 * channel. `stable`, `beta` and `nightly` are channels: recorded as floating, not as a version.
 */
export function parseRustToolchain(text: string, path: string): RuntimePinRecord[] {
  const body = text.replace(/^\uFEFF/, '')
  let channel: string | null = null
  let line: number | null = null
  if (/^\s*\[toolchain\]/m.test(body) || /^\s*channel\s*=/m.test(body)) {
    const root = tryParse(body)
    channel = root ? asString(asTable(root['toolchain'])['channel']) || null : null
    line = tomlKeyLine(body, 'toolchain', 'channel')
  } else {
    const lines = body.split(/\r?\n/)
    for (let n = 0; n < lines.length; n++) {
      const value = (lines[n] ?? '').replace(/\s*#.*$/, '').trim()
      if (value !== '') {
        channel = value
        line = n + 1
        break
      }
    }
  }
  if (channel === null) return []
  return [
    makePin(
      { runtime: 'rust', source: 'rust_toolchain', path, line, raw: channel, scope: 'dev' },
      readPinValue('rust', channel),
    ),
  ]
}

/**
 * `Cargo.toml` `rust-version`: the minimum supported Rust version (MSRV), not the toolchain that
 * runs. Recorded with kind `minimum` so no check treats it as the running version.
 */
export function parseCargoToml(text: string, path: string): RuntimePinRecord[] {
  const root = tryParse(text)
  if (!root) return []
  const pins: RuntimePinRecord[] = []
  for (const table of ['package', 'workspace.package']) {
    const parts = table.split('.')
    let node: TomlValue | undefined = root
    for (const part of parts) node = isTable(node) ? node[part] : undefined
    if (!isTable(node)) continue
    const line = tomlKeyLine(text, table, 'rust-version')
    const raw = valueText(node['rust-version'], text, line)
    if (raw === null) continue
    const value = readPinValue('rust', raw)
    pins.push(
      makePin(
        { runtime: 'rust', source: 'cargo_rust_version', path, line, raw, scope: 'dev' },
        value,
        value.kind === 'unknown' ? 'unknown' : 'minimum',
      ),
    )
  }
  return pins
}
