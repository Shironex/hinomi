import type { Runtime, RuntimePinRecord } from '@hinomi/shared'
import { parseDockerfilePins } from './dockerfile.js'
import { parsePackageJson } from './manifest.js'
import { lowerBasename } from './pin.js'
import { parseCargoToml, parseMiseToml, parseRustToolchain } from './toml-files.js'
import { parseToolVersions, parseVersionFile } from './version-files.js'
import { parseWorkflow } from './workflow.js'

/** A file of the repo, its repo relative path and text. */
export interface PinFile {
  path: string
  text: string
}

export interface ReadPinsOptions {
  /**
   * Repo relative paths of the Dockerfiles a deployment builds; the final stage of each runs in
   * production. Default: the root `Dockerfile`.
   */
  productionDockerfiles?: ReadonlySet<string>
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i

export function isDockerfileName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'dockerfile' ||
    lower === 'containerfile' ||
    lower.startsWith('dockerfile.') ||
    lower.endsWith('.dockerfile')
  )
}

export const isWorkflowPath = (path: string): boolean => WORKFLOW_PATH.test(path)

const VERSION_FILE_NAMES = new Set([
  '.nvmrc',
  '.node-version',
  '.bun-version',
  '.tool-versions',
  'mise.toml',
  '.mise.toml',
  'package.json',
  'rust-toolchain',
  'rust-toolchain.toml',
  'cargo.toml',
])

/** True for the files the readers look at, so a fetch only asks for those. */
export function isPinFilePath(path: string): boolean {
  const name = lowerBasename(path)
  return VERSION_FILE_NAMES.has(name) || isDockerfileName(name) || isWorkflowPath(path)
}

const DEFAULT_PRODUCTION = new Set(['Dockerfile'])

function parseFile(
  file: PinFile,
  production: ReadonlySet<string>,
  resolveFile: (path: string, runtime: Runtime) => RuntimePinRecord | null,
): RuntimePinRecord[] {
  const { path, text } = file
  const name = lowerBasename(path)
  switch (name) {
    case '.nvmrc':
      return parseVersionFile(text, path, 'node', 'nvmrc')
    case '.node-version':
      return parseVersionFile(text, path, 'node', 'node_version')
    case '.bun-version':
      return parseVersionFile(text, path, 'bun', 'bun_version')
    case '.tool-versions':
      return parseToolVersions(text, path)
    case 'mise.toml':
    case '.mise.toml':
      return parseMiseToml(text, path)
    case 'package.json':
      return parsePackageJson(text, path)
    case 'rust-toolchain':
    case 'rust-toolchain.toml':
      return parseRustToolchain(text, path)
    case 'cargo.toml':
      return parseCargoToml(text, path)
    default:
  }
  if (isDockerfileName(name)) {
    return parseDockerfilePins(text, path, { production: production.has(path) })
  }
  if (isWorkflowPath(path)) return parseWorkflow(text, path, { resolveFile })
  return []
}

/**
 * Every Node, Bun and Rust pin in the given files. Files that are not pin files are ignored; a
 * file that cannot be read gives no pins. The files are attacker controlled input: nothing here
 * indexes an object by a name taken from them.
 */
export function readRuntimePins(
  files: readonly PinFile[],
  options: ReadPinsOptions = {},
): RuntimePinRecord[] {
  const production = options.productionDockerfiles ?? DEFAULT_PRODUCTION
  const byPath = new Map<string, PinFile>()
  for (const file of files) byPath.set(file.path, file)

  // `node-version-file: .nvmrc` takes the value of the file it names (read without workflows,
  // so a chain of references cannot loop).
  const resolveFile = (path: string, runtime: Runtime): RuntimePinRecord | null => {
    const named = byPath.get(path)
    if (!named || isWorkflowPath(named.path)) return null
    const pins = parseFile(named, production, () => null).filter(
      (pin) => pin.runtime === runtime && pin.kind !== 'minimum',
    )
    return pins[0] ?? null
  }

  const seen = new Set<string>()
  const pins: RuntimePinRecord[] = []
  for (const file of files) {
    for (const pin of parseFile(file, production, resolveFile)) {
      const key = [pin.runtime, pin.source, pin.path, pin.line, pin.raw, pin.job].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      pins.push(pin)
    }
  }
  return pins
}

/**
 * Where a pin ranks when deciding what runs in production (design section 5.4): the final stage
 * of a deployed Dockerfile, then the version files, then the `engines` floor. CI pins, build
 * stages and minimum versions never decide it.
 */
const PRODUCTION_RANK = [
  'dockerfile',
  'nvmrc',
  'node_version',
  'bun_version',
  'rust_toolchain',
  'tool_versions',
  'mise',
  'volta',
  'package_manager',
  'dev_engines',
  'engines',
] as const

/**
 * The pin that says what a runtime runs on in production, or null when no file says. A floating
 * pin can win (production floats on purpose); an unreadable one only when nothing else is left.
 */
export function productionPin(
  pins: readonly RuntimePinRecord[],
  runtime: Runtime,
): RuntimePinRecord | null {
  const candidates = pins.filter(
    (pin) =>
      pin.runtime === runtime &&
      pin.kind !== 'minimum' &&
      pin.scope !== 'ci' &&
      (pin.source !== 'dockerfile' || pin.scope === 'production'),
  )
  const rank = (pin: RuntimePinRecord) =>
    (pin.kind === 'unknown' ? 100 : 0) + (PRODUCTION_RANK as readonly string[]).indexOf(pin.source)
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b))
  return sorted[0] ?? null
}
