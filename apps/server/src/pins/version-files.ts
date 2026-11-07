import type { Runtime, RuntimePinRecord } from '@hinomi/shared'
import { makePin, runtimeOfToolName } from './pin.js'
import { readPinValue } from './value.js'

/** The first line of a version file that is not blank or a comment: `.nvmrc`, `.bun-version`. */
function firstValue(text: string): { raw: string; line: number } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    const raw = (lines[n] ?? '').replace(/\s+#.*$/, '').trim()
    if (raw !== '' && !raw.startsWith('#')) return { raw, line: n + 1 }
  }
  return null
}

/** `.nvmrc` and `.node-version` (Node), `.bun-version` (Bun): a single value. */
export function parseVersionFile(
  text: string,
  path: string,
  runtime: Runtime,
  source: 'nvmrc' | 'node_version' | 'bun_version',
): RuntimePinRecord[] {
  const found = firstValue(text)
  if (!found) return []
  return [
    makePin(
      { runtime, source, path, line: found.line, raw: found.raw, scope: 'dev' },
      readPinValue(runtime, found.raw),
    ),
  ]
}

/**
 * `.tool-versions` (asdf, mise): `nodejs 22.11.0`. The first version of a tool is the one used,
 * the rest are fallbacks; `system`, `ref:` and `path:` give nothing.
 */
export function parseToolVersions(text: string, path: string): RuntimePinRecord[] {
  const pins: RuntimePinRecord[] = []
  const seen = new Set<string>()
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    const parts = (lines[n] ?? '')
      .replace(/\s*#.*$/, '')
      .trim()
      .split(/\s+/)
    const name = parts[0]
    const raw = parts[1]
    if (name === undefined || raw === undefined) continue
    const runtime = runtimeOfToolName(name)
    if (runtime === null || seen.has(runtime)) continue
    seen.add(runtime)
    if (raw === 'system' || raw.startsWith('ref:') || raw.startsWith('path:')) continue
    pins.push(
      makePin(
        { runtime, source: 'tool_versions', path, line: n + 1, raw, scope: 'dev' },
        readPinValue(runtime, raw),
      ),
    )
  }
  return pins
}
